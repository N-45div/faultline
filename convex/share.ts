import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { limits } from "./limits";
import { paused, providerFault } from "./guard";
import { validSession, webIdentity } from "../engine/web";
import { masked, shareable, shareLetter } from "../engine/shareLetter";

// A tenant's answer, sent on. After an answer is kept on /try, the tenant can
// name one person who is helping them - an organizer, a lawyer, a relative -
// and Faultline's agent writes to that person from its own AgentMail inbox:
// the city's record for the repair, and the tenant's answer in one word. The
// page watches the letter go out (AgentMail's delivery events) and shows their
// reply when it comes back into the same thread. Nothing the tenant typed is
// in the letter, so the box cannot be used to mail anyone anything else.

const API = process.env.AGENTMAIL_BASE_URL ?? "https://api.agentmail.to/v0";
const inbox = () => process.env.AGENTMAIL_INBOX_ID ?? "getnotice@agentmail.to";
const site = () => (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");

type Result = { ok: boolean; why?: string };

/** Send the record for one answered repair to one address. Refusals say why. */
export const send = mutation({
  args: { session: v.string(), violationId: v.string(), to: v.string() },
  returns: v.object({ ok: v.boolean(), why: v.optional(v.string()) }),
  handler: async (ctx, { session, violationId, to }): Promise<Result> => {
    if (!validSession(session) || !/^\d{5,10}$/.test(violationId)) return { ok: false, why: "This page lost its place. Reload it and try again." };
    if (paused("mail")) return { ok: false, why: "Sending is paused right now. Nothing was sent." };
    const address = to.trim().toLowerCase();
    if (!shareable(address)) return { ok: false, why: "That isn't an address we can write to." };
    // Only a repair answered on this page: the letter carries that answer.
    const answered = await ctx.db
      .query("attestations")
      .withIndex("by_email_violation", (q) => q.eq("email", webIdentity(session)).eq("violationId", violationId))
      .first();
    if (!answered?.answer) return { ok: false, why: "Answer the repair first: the letter carries your answer." };
    const ruled = await ctx.db.query("suppressions").withIndex("by_email", (q) => q.eq("email", address)).first();
    if (ruled) return { ok: false, why: "That address asked us to stop, or mail to it came back. We won't write to it." };
    // Checked first and spent only when every one has room, so a refusal costs nothing.
    const rooms = [
      ["shareTo", { key: address }, "That address already had a letter from us today."],
      ["shareSender", { key: session }, "This page has sent three letters today."],
      ["shareAll", {}, "The trial has sent all the letters it may today. Try tomorrow."],
      ["replyAll", {}, "The inbox has sent all it may today. Try tomorrow."],
    ] as const;
    for (const [name, opts, why] of rooms) if (!(await limits.check(ctx, name, opts)).ok) return { ok: false, why };
    for (const [name, opts] of rooms) await limits.limit(ctx, name, opts);
    const shareId = await ctx.db.insert("shares", { session, violationId, to: address, status: "queued", createdAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.share.deliver, { shareId });
    return { ok: true };
  },
});

/** What the letter is built from: the share, and the answer's own fields. */
export const job = internalQuery({
  args: { shareId: v.id("shares") },
  returns: v.any(),
  handler: async (ctx, { shareId }) => {
    const share = await ctx.db.get(shareId);
    if (!share || share.status !== "queued") return null;
    const answered = await ctx.db
      .query("attestations")
      .withIndex("by_email_violation", (q) => q.eq("email", webIdentity(share.session)).eq("violationId", share.violationId))
      .first();
    return answered?.answer ? { share, answered } : null;
  },
});

export const mark = internalMutation({
  args: {
    shareId: v.id("shares"),
    status: v.string(),
    why: v.optional(v.string()),
    outboundId: v.optional(v.string()),
    mailThreadId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { shareId, ...set }) => {
    await ctx.db.patch(shareId, { ...set, statusAt: Date.now() });
    return null;
  },
});

/** One letter, from the agent's inbox. The Idempotency-Key makes a retried send the same send. */
export const deliver = internalAction({
  args: { shareId: v.id("shares") },
  returns: v.null(),
  handler: async (ctx, { shareId }) => {
    const j: { share: Doc<"shares">; answered: Doc<"attestations"> } | null = await ctx.runQuery(internal.share.job, { shareId });
    if (!j) return null;
    const key = process.env.AGENTMAIL_API_KEY;
    if (!key || paused("mail") || (await ctx.runQuery(internal.breaker.open, { provider: "agentmail" }))) {
      await ctx.runMutation(internal.share.mark, { shareId, status: "failed", why: "Sending is paused right now. Nothing was sent." });
      return null;
    }
    const a = j.answered;
    const letter = shareLetter({
      violationId: a.violationId,
      bbl: a.subjectKey,
      hazardClass: a.hazardClass,
      description: a.description,
      askedStatus: a.askedStatus,
      askedStatusDate: a.askedStatusDate,
      certifiedBy: a.certifiedBy,
      answer: a.answer!,
      saidAt: a.saidAt ?? a.askedAt,
      site: site(),
      inbox: inbox(),
    });
    let sent: { message_id: string; thread_id?: string };
    try {
      const res = await fetch(`${API}/inboxes/${encodeURIComponent(inbox())}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Idempotency-Key": `share-${shareId}` },
        body: JSON.stringify({ to: [j.share.to], subject: letter.subject, text: letter.text, labels: ["share"], headers: { "Auto-Submitted": "auto-generated" } }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.message_id !== "string") {
        const err = new Error(`AgentMail ${res.status}: ${String(data?.message ?? "").slice(0, 160)}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      sent = data;
    } catch (e) {
      console.error(`[share] send failed: ${String(e)}`);
      if (providerFault(e)) await ctx.runMutation(internal.breaker.record, { provider: "agentmail", ok: false, error: String(e) });
      // Only an error status is AgentMail saying no. No answer at all - the
      // connection dropped, the wait ran out, or an answer we could not read -
      // can come after AgentMail took the letter, so the page says only what is
      // known. Nothing sends it again on its own: a retry of this share would
      // carry the same Idempotency-Key and be the same send, and a new share to
      // the same address is refused for the day. If AgentMail does report the
      // letter, shareEvent moves this row to what it says.
      const status = (e as { status?: number } | null)?.status;
      const refused = typeof status === "number" && (status < 200 || status >= 300) && !GATEWAY.has(status);
      await ctx.runMutation(
        internal.share.mark,
        refused ? { shareId, status: "failed", why: NOT_SENT } : { shareId, status: "unconfirmed", why: UNCONFIRMED },
      );
      return null;
    }
    await ctx.runMutation(internal.share.mark, { shareId, status: "sent", outboundId: sent.message_id, mailThreadId: sent.thread_id });
    await ctx.runMutation(internal.breaker.record, { provider: "agentmail", ok: true });
    return null;
  },
});

/** How long a send may take before the page stops waiting for AgentMail's answer. */
const SEND_TIMEOUT_MS = 30_000;
/** Statuses from something in front of AgentMail that lost it mid-request: the letter may have been taken. */
const GATEWAY = new Set([502, 504]);
const NOT_SENT = "AgentMail didn't take it. Nothing was sent.";
const UNCONFIRMED = "Delivery could not be confirmed. It may still arrive; if AgentMail reports it, this line will say so.";

const vReply = v.object({ text: v.string(), at: v.number() });
type Reply = { text: string; at: number };

/** At most this many replies are kept on one letter, the newest. */
const KEPT_REPLIES = 20;

/** Every reply on a letter, oldest first. A row from before the list keeps its one reply in replyText. */
function repliesOf(s: Doc<"shares">): Reply[] {
  if (s.replies) return s.replies;
  return s.replyText ? [{ text: s.replyText, at: s.replyAt ?? s.statusAt ?? s.createdAt }] : [];
}

/** The letters this page sent, newest first, the address masked, each with every reply in order. */
export const forSession = query({
  args: { session: v.string() },
  returns: v.array(
    v.object({
      id: v.string(),
      violationId: v.string(),
      to: v.string(),
      status: v.string(),
      at: v.number(),
      why: v.optional(v.string()),
      replies: v.array(vReply),
      stopped: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx, { session }) => {
    if (!validSession(session)) return [];
    const rows = await ctx.db.query("shares").withIndex("by_session", (q) => q.eq("session", session)).order("desc").take(5);
    return rows.map((s) => ({
      id: String(s._id),
      violationId: s.violationId,
      to: masked(s.to),
      status: s.status,
      at: s.statusAt ?? s.createdAt,
      ...(s.why ? { why: s.why } : {}),
      replies: repliesOf(s),
      ...(s.stopped ? { stopped: true } : {}),
    }));
  },
});

/** AgentMail's word on a letter we sent: sent, delivered, bounced, complained, rejected. */
export async function shareEvent(ctx: MutationCtx, messageId: string, status: string): Promise<void> {
  const share = await ctx.db.query("shares").withIndex("by_outbound", (q) => q.eq("outboundId", messageId)).first();
  if (!share) return;
  // Delivered is not undone by a late "sent".
  if (share.status === "delivered" && status === "sent") return;
  await ctx.db.patch(share._id, { status, statusAt: Date.now() });
}

/**
 * A reply in the thread of a letter we sent. Kept only from the address we
 * wrote to, and never answered: the agent does not write back to a helper on
 * its own, so two agents can never talk to each other in a loop. Every reply
 * is kept, in the order it came, after any the row already had.
 */
export async function shareReply(ctx: MutationCtx, share: Doc<"shares">, from: string, words: string, stop: boolean): Promise<boolean> {
  if (from.trim().toLowerCase() !== share.to) return false;
  const text = words.replace(/\s+/g, " ").trim().slice(0, 500);
  const replies = [...repliesOf(share), { text: text || "(a reply with no words)", at: Date.now() }].slice(-KEPT_REPLIES);
  await ctx.db.patch(share._id, { replies, ...(stop ? { stopped: true } : {}) });
  return true;
}

export type ShareId = Id<"shares">;
