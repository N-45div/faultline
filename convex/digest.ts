import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { complianceLines } from "../engine/receipt";
import { paused } from "./guard";

// One email per person per day, at most — and the first one goes out within a
// minute of the change that caused it. Ingest never sends; it queues. This runs
// every minute, gathers everything waiting for one person into a single note,
// and holds the rest until tomorrow.

const NL = String.fromCharCode(10);
const DAY_MS = 86_400_000;
/** Nobody hears from us more often than this, however much moves. */
const MIN_GAP_MS = DAY_MS;
/** How far down the queue one run looks, and how much of it one person may own. */
const SCAN_PER_RUN = 1000;
/** How many of one person's queued lines a single run will claim. */
const MAX_CLAIMED_PER_EMAIL = 40;
const MAX_RECIPIENTS_PER_RUN = 20;
const MAX_LINES_PER_EMAIL = 12;

export const flush = internalMutation({
  args: {},
  returns: v.object({ sent: v.number(), held: v.number() }),
  handler: async (ctx) => {
    const inbox = process.env.AGENTMAIL_INBOX_ID;
    if (!inbox || !process.env.AGENTMAIL_API_KEY) return { sent: 0, held: 0 };
    // Paused mail waits in the queue; nothing is dropped.
    if (paused("mail")) return { sent: 0, held: 0 };

    // Oldest first, but bounded per person. One recipient with a backlog
    // larger than this window used to fill it entirely — and because a gated
    // recipient's rows are held rather than claimed, the same rows came back
    // every minute and nobody else's alert was ever looked at.
    const pending = await ctx.db
      .query("alertQueue")
      .withIndex("by_status_created", (q) => q.eq("status", "pending"))
      .order("asc")
      .take(SCAN_PER_RUN);
    if (pending.length === 0) return { sent: 0, held: 0 };

    const byEmail = new Map<string, Doc<"alertQueue">[]>();
    for (const a of pending) {
      const rows = byEmail.get(a.email) ?? [];
      if (rows.length >= MAX_CLAIMED_PER_EMAIL) continue;
      rows.push(a);
      byEmail.set(a.email, rows);
    }

    const now = Date.now();
    let sent = 0;
    let held = 0;

    for (const [email, rows] of byEmail) {
      if (sent >= MAX_RECIPIENTS_PER_RUN) {
        held += rows.length;
        continue;
      }
      const subs = await ctx.db
        .query("subscriptions")
        .withIndex("by_email", (q) => q.eq("email", email))
        .collect();
      // Unconfirmed follows are shown on the site and never emailed. Without
      // this, signing up as someone else's address and following anything
      // would make us mail a stranger.
      const active = subs.filter((s) => s.active && s.confirmed !== false);
      if (active.length === 0) {
        // They said STOP after the news was queued. Drop it, don't send it.
        for (const r of rows) await ctx.db.patch(r._id, { status: "sent", sentAt: now });
        continue;
      }
      const lastEmailedAt = Math.max(0, ...active.map((s) => s.lastEmailedAt ?? 0));
      if (now - lastEmailedAt < MIN_GAP_MS) {
        held += rows.length;
        continue;
      }

      // Claim before sending: the send is scheduled from this transaction, so
      // a second run a minute later cannot pick the same rows up again. If the
      // send then fails, `requeue` below puts them back — a claim is not a
      // promise that it went out.
      const claimed = rows.map((r) => r._id);
      for (const r of rows) await ctx.db.patch(r._id, { status: "sent", sentAt: now });
      for (const s of active) await ctx.db.patch(s._id, { lastEmailedAt: now });

      const bySubject = new Map<string, Doc<"alertQueue">[]>();
      for (const r of rows) bySubject.set(r.subjectKey, [...(bySubject.get(r.subjectKey) ?? []), r]);

      const lines: string[] = [];
      const asks: Doc<"alertQueue">[] = [];
      let used = 0;
      for (const [, group] of bySubject) {
        for (const g of group) {
          if (g.ask) {
            asks.push(g);
            continue;
          }
          if (used >= MAX_LINES_PER_EMAIL) break;
          lines.push(`- ${g.sentence}`);
          used++;
        }
      }
      // The questions: one block, the claims listed, the three words that
      // answer. Each claim asked becomes a row waiting for the person's word,
      // dated from the moment it was sent. Silence stays silence.
      const askLines: string[] = [];
      for (const g of asks.slice(0, MAX_LINES_PER_EMAIL)) {
        askLines.push(`- ${g.sentence}`);
        const a = g.ask!;
        const dup = await ctx.db
          .query("attestations")
          .withIndex("by_email_violation", (q) => q.eq("email", email).eq("violationId", a.violationId))
          .order("desc")
          .first();
        if (dup && dup.answer === undefined && dup.askedStatus === a.status) continue;
        await ctx.db.insert("attestations", {
          email,
          subjectKey: g.subjectKey,
          violationId: a.violationId,
          askedAt: now,
          askedStatus: a.status,
          askedStatusDate: a.statusDate,
          certifiedBy: a.certifiedBy,
          hazardClass: a.hazardClass,
          description: a.description,
        });
      }
      const more = rows.length - used - Math.min(asks.length, MAX_LINES_PER_EMAIL);
      const subjectCount = bySubject.size;
      const onlyAsks = lines.length === 0 && askLines.length > 0;
      const headline = onlyAsks
        ? askLines.length === 1
          ? "They say it's fixed. Is it?"
          : `They say ${askLines.length} things are fixed. Are they?`
        : rows.length === 1
          ? "A filing you follow changed."
          : `${rows.length} changes to ${subjectCount === 1 ? "a filing" : `${subjectCount} filings`} you follow.`;
      const text = [
        headline,
        "",
        ...lines,
        ...(lines.length > 0 && askLines.length > 0 ? ["", "And a question:"] : []),
        ...askLines,
        ...(askLines.length > 0
          ? [
              "",
              "Reply with the number and one of FIXED, STILL BROKEN or NOT SURE — for example: #12345678 STILL BROKEN. Add a photo if you have one.",
              "Your answer is kept beside the city's record, dated. If the city later stamps the certification false, we'll tell you.",
            ]
          : []),
        ...(more > 0 ? [`- …and ${more} more.`] : []),
        "",
        `Check it on the government's own page: ${rows[0].sourceUrl}`,
        "We kept the version before this one, dated. Reply PACK and the name for the whole record as a PDF.",
        "",
        "We send at most one of these a day.",
        ...complianceLines(process.env.NOTICE_POSTAL, "you are getting this because you replied FOLLOW."),
      ].join(NL);

      // Answer in the thread where this filing or building was followed, so
      // "Is it fixed?" about a building never lands under an employer's
      // subject line. Failing that, any thread — except a question, which
      // starts its own with its own subject.
      const subjects = new Set(rows.map((r) => r.subjectKey));
      const withThread = active.find((s) => s.messageId && subjects.has(s.subjectKey)) ?? (onlyAsks ? undefined : active.find((s) => s.messageId));
      if (withThread?.messageId) {
        await ctx.scheduler.runAfter(0, internal.mail.reply, {
          agentInboxId: inbox,
          parentMessageId: withThread.messageId,
          text,
          onFailure: { alertIds: claimed, email },
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.mail.send, {
          agentInboxId: inbox,
          to: email,
          subject: onlyAsks ? "Is it fixed?" : rows.length === 1 ? "A filing you follow changed" : "Filings you follow changed",
          text,
          onFailure: { alertIds: claimed, email },
        });
      }
      sent++;
    }

    if (sent > 0 || held > 0) console.log(`[digest] sent=${sent} held=${held}`);
    return { sent, held };
  },
});

/**
 * The send did not happen. Put the news back and let this person hear from us
 * again on the next pass — a claim is only a claim until the mail is accepted.
 */
export const requeue = internalMutation({
  args: { alertIds: v.array(v.id("alertQueue")), email: v.string(), dropThread: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { alertIds, email, dropThread }) => {
    for (const id of alertIds.slice(0, 500)) {
      const row = await ctx.db.get(id);
      if (row && row.status === "sent") await ctx.db.patch(id, { status: "pending", sentAt: undefined });
    }
    const subs = await ctx.db.query("subscriptions").withIndex("by_email", (q) => q.eq("email", email)).collect();
    for (const s of subs) {
      // Clear the ceiling so the retry is not held for a day it never got.
      await ctx.db.patch(s._id, { lastEmailedAt: undefined, ...(dropThread ? { messageId: undefined } : {}) });
    }
    console.warn(`[digest] send failed for ${email}; ${alertIds.length} alerts requeued${dropThread ? ", thread forgotten" : ""}`);
    return null;
  },
});

/** What is waiting, and for whom — used by the demo page and by debugging. */
export const waiting = internalQuery({
  args: {},
  returns: v.array(v.object({ email: v.string(), pending: v.number(), lastEmailedAt: v.optional(v.number()) })),
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("alertQueue")
      .withIndex("by_status_created", (q) => q.eq("status", "pending"))
      .take(200);
    const byEmail = new Map<string, number>();
    for (const a of pending) byEmail.set(a.email, (byEmail.get(a.email) ?? 0) + 1);
    const out: { email: string; pending: number; lastEmailedAt?: number }[] = [];
    for (const [email, count] of byEmail) {
      const subs = await ctx.db.query("subscriptions").withIndex("by_email", (q) => q.eq("email", email)).collect();
      const last = Math.max(0, ...subs.map((s) => s.lastEmailedAt ?? 0));
      out.push({ email, pending: count, lastEmailedAt: last || undefined });
    }
    return out;
  },
});

/** Sent alert rows older than a week are history nobody reads; the receipts hold the words. */
export const gc = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const old = await ctx.db
      .query("alertQueue")
      .withIndex("by_status_created", (q) => q.eq("status", "sent").lt("createdAt", cutoff))
      .take(500);
    for (const r of old) await ctx.db.delete(r._id);
    return old.length;
  },
});
