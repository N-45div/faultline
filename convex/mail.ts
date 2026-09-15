import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { paused, providerFault } from "./guard";

// Outbound mail. The AgentMail component handles inbound (webhook, events,
// storage); sending goes straight to AgentMail's API from the app, because a
// component runs with its own environment and cannot see the deployment's API
// key. Tried again on 15 September with the component's send queue: every
// send failed with "AGENTMAIL_API_KEY is not set". Every message we send is
// machine-generated and says so: RFC 3834's Auto-Submitted header is how we
// tell other robots not to answer us back.

const API = process.env.AGENTMAIL_BASE_URL ?? "https://api.agentmail.to/v0";

const attachmentValidator = v.object({
  filename: v.string(),
  content: v.string(),
  contentType: v.optional(v.string()),
});

/** Queued news that must go back in the queue if this send does not happen. */
const onFailureValidator = v.object({
  alertIds: v.array(v.id("alertQueue")),
  email: v.string(),
});

async function call(path: string, body: unknown): Promise<{ message_id: string; thread_id: string }> {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new Error("AGENTMAIL_API_KEY is not set");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`AgentMail ${res.status}: ${data?.message ?? JSON.stringify(data).slice(0, 200)}`);
    // The status travels with the error so the breaker can tell a dead thread
    // (404, this message only) from AgentMail being down (5xx, everyone).
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return data;
}

function wire(attachments?: { filename: string; content: string; contentType?: string }[]) {
  return attachments?.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType ?? "application/octet-stream" }));
}

/** Answer in the same thread. Marks the inbox row and receipt on success. */
/**
 * Paused by hand, or the provider's breaker is open: the message goes back
 * to the queue when it came from one, and is not attempted.
 */
// Held mail is re-tried for about an hour: long enough to ride out a breaker
// cool-off or a hand-set pause, short enough that a person still recognises
// the reply when it lands.
const HELD_RETRY_MS = 10 * 60_000;
const HELD_RETRIES = 6;

async function held(ctx: { runQuery: (ref: any, args: any) => Promise<any> }, what: string): Promise<boolean> {
  if (paused("mail")) {
    console.warn(`[mail] ${what} held: NOTICE_PAUSE`);
    return true;
  }
  if (await ctx.runQuery(internal.breaker.open, { provider: "agentmail" })) {
    console.warn(`[mail] ${what} held: agentmail breaker open`);
    return true;
  }
  return false;
}

export const reply = internalAction({
  args: {
    agentInboxId: v.string(),
    parentMessageId: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    attachments: v.optional(v.array(attachmentValidator)),
    receiptId: v.optional(v.id("receipts")),
    inboxId: v.optional(v.id("inbox")),
    onFailure: v.optional(onFailureValidator),
    /** How many times this has been re-scheduled while mail was held. */
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    if (await held(ctx, "reply")) {
      if (a.onFailure) await ctx.runMutation(internal.digest.requeue, { ...a.onFailure, dropThread: false });
      // A queued alert goes back to the queue; a reply to a person who wrote to
      // us has no queue, so it is re-scheduled. "Nothing is dropped" has to be
      // true of the reply path too, or someone who emailed us gets silence.
      else if ((a.attempt ?? 0) < HELD_RETRIES) await ctx.scheduler.runAfter(HELD_RETRY_MS, internal.mail.reply, { ...a, attempt: (a.attempt ?? 0) + 1 });
      else console.error(`[mail] reply abandoned after ${HELD_RETRIES} held attempts`);
      return null;
    }
    try {
      const r = await call(`/inboxes/${encodeURIComponent(a.agentInboxId)}/messages/${encodeURIComponent(a.parentMessageId)}/reply`, {
        text: a.text,
        html: a.html,
        attachments: wire(a.attachments),
        headers: { "Auto-Submitted": "auto-replied" },
      });
      await ctx.runMutation(internal.mail.markSent, { receiptId: a.receiptId, inboxId: a.inboxId, outboundId: r.message_id });
      await ctx.runMutation(internal.breaker.record, { provider: "agentmail", ok: true });
      console.log(`[mail] replied in thread ${r.thread_id}`);
    } catch (e) {
      console.error(`[mail] reply failed: ${String(e)}`);
      // A 404 on a thread that aged out is this message's problem, not the
      // provider's; counting it would silence everybody for fifteen minutes.
      if (providerFault(e)) await ctx.runMutation(internal.breaker.record, { provider: "agentmail", ok: false, error: String(e) });
      // A thread can go stale — the message aged out, or the person deleted it.
      // Put the news back and forget the thread, so the retry starts a new one.
      if (a.onFailure) await ctx.runMutation(internal.digest.requeue, { ...a.onFailure, dropThread: true });
    }
    return null;
  },
});

/** A fresh message — used when a follower has no thread with us. */
export const send = internalAction({
  args: {
    agentInboxId: v.string(),
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    attachments: v.optional(v.array(attachmentValidator)),
    onFailure: v.optional(onFailureValidator),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    if (await held(ctx, "send")) {
      if (a.onFailure) await ctx.runMutation(internal.digest.requeue, { ...a.onFailure, dropThread: false });
      else if ((a.attempt ?? 0) < HELD_RETRIES) await ctx.scheduler.runAfter(HELD_RETRY_MS, internal.mail.send, { ...a, attempt: (a.attempt ?? 0) + 1 });
      else console.error(`[mail] send abandoned after ${HELD_RETRIES} held attempts`);
      return null;
    }
    try {
      const r = await call(`/inboxes/${encodeURIComponent(a.agentInboxId)}/messages/send`, {
        to: [a.to],
        subject: a.subject,
        text: a.text,
        html: a.html,
        attachments: wire(a.attachments),
        headers: { "Auto-Submitted": "auto-generated" },
      });
      await ctx.runMutation(internal.breaker.record, { provider: "agentmail", ok: true });
      console.log(`[mail] sent ${r.message_id} to ${a.to}`);
    } catch (e) {
      console.error(`[mail] send failed: ${String(e)}`);
      // A 404 on a thread that aged out is this message's problem, not the
      // provider's; counting it would silence everybody for fifteen minutes.
      if (providerFault(e)) await ctx.runMutation(internal.breaker.record, { provider: "agentmail", ok: false, error: String(e) });
      if (a.onFailure) await ctx.runMutation(internal.digest.requeue, { ...a.onFailure, dropThread: false });
    }
    return null;
  },
});

export const markSent = internalMutation({
  args: { receiptId: v.optional(v.id("receipts")), inboxId: v.optional(v.id("inbox")), outboundId: v.string() },
  returns: v.null(),
  handler: async (ctx, { receiptId, inboxId, outboundId }) => {
    if (receiptId) await ctx.db.patch(receiptId, { outboundId });
    if (inboxId) await ctx.db.patch(inboxId, { replied: true });
    return null;
  },
});
