import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Outbound mail. The AgentMail component handles inbound (webhook, threads,
// storage); sending goes straight to AgentMail's API from the app, because a
// component cannot see the deployment's API key.

const API = process.env.AGENTMAIL_BASE_URL ?? "https://api.agentmail.to/v0";

async function call(path: string, body: unknown): Promise<{ message_id: string; thread_id: string }> {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new Error("AGENTMAIL_API_KEY is not set");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AgentMail ${res.status}: ${data?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** Answer in the same thread. Marks the inbox row and receipt on success. */
export const reply = internalAction({
  args: {
    agentInboxId: v.string(),
    parentMessageId: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    receiptId: v.optional(v.id("receipts")),
    inboxId: v.optional(v.id("inbox")),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    try {
      const r = await call(`/inboxes/${encodeURIComponent(a.agentInboxId)}/messages/${encodeURIComponent(a.parentMessageId)}/reply`, {
        text: a.text,
        html: a.html,
      });
      await ctx.runMutation(internal.mail.markSent, { receiptId: a.receiptId, inboxId: a.inboxId, outboundId: r.message_id });
      console.log(`[mail] replied in thread ${r.thread_id}`);
    } catch (e) {
      console.error(`[mail] reply failed: ${String(e)}`);
    }
    return null;
  },
});

/** A fresh message — used when a follower has no thread with us. */
export const send = internalAction({
  args: { agentInboxId: v.string(), to: v.string(), subject: v.string(), text: v.string(), html: v.optional(v.string()) },
  returns: v.null(),
  handler: async (_ctx, a) => {
    try {
      const r = await call(`/inboxes/${encodeURIComponent(a.agentInboxId)}/messages/send`, {
        to: [a.to],
        subject: a.subject,
        text: a.text,
        html: a.html,
      });
      console.log(`[mail] sent ${r.message_id} to ${a.to}`);
    } catch (e) {
      console.error(`[mail] send failed: ${String(e)}`);
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
