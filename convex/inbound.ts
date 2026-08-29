import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { AgentMail } from "@agentmail/convex";
import { fnv1a64 } from "../engine/canon";
import { looksLikeAddress } from "../engine/match";
import { classifyInbound, emailAddressOf, stripHtml } from "../engine/intent";
import { noMatchReceipt, receiptHtml, receiptText, type Receipt } from "../engine/receipt";
import { buildReceipt, guessCompanyFromText } from "./lookup";

// The address is a search box that writes back. Everything a person can do by
// email lands here, is classified without a model, and is answered in-thread.

const agentmail = new AgentMail(components.agentmail);
const MAX_REPLIES_PER_SENDER_PER_DAY = 20;

export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, { message }) => {
    await handleInbound(ctx, message, true);
    return null;
  },
});

export interface InboundResult {
  intent: string;
  query: string;
  kind: Receipt["kind"];
  text: string;
  sent: boolean;
  duplicate?: boolean;
}

export async function handleInbound(ctx: MutationCtx, m: any, authenticated: boolean): Promise<InboundResult> {
  const messageId = String(m?.message_id ?? "");
  if (!messageId) throw new Error("inbound message without message_id");

  const existing = await ctx.db.query("inbox").withIndex("by_message_id", (q) => q.eq("messageId", messageId)).unique();
  if (existing) return { intent: existing.intent, query: existing.query, kind: "none", text: "", sent: existing.replied, duplicate: true };

  const from = emailAddressOf(String(m.from ?? ""));
  const subject = String(m.subject ?? "");
  const body = String(m.extracted_text ?? m.text ?? (m.html ? stripHtml(String(m.html)) : ""));
  const intent = classifyInbound(subject, body);
  const query = intent.kind === "lookup" ? intent.query : intent.kind;
  const now = Date.now();
  const threadId = String(m.thread_id ?? "");

  const inboxId = await ctx.db.insert("inbox", {
    messageId,
    threadId,
    inboxId: String(m.inbox_id ?? ""),
    fromAddress: from,
    subject,
    receivedAt: now,
    authenticated,
    intent: intent.kind,
    query,
    bodyHash: fnv1a64(body),
    replied: false,
  });

  // Politeness ceiling per sender. Unauthenticated mail is stored, never answered.
  const recent = await ctx.db
    .query("inbox")
    .withIndex("by_from", (q) => q.eq("fromAddress", from).gte("receivedAt", now - 86_400_000))
    .collect();
  if (!authenticated || recent.length > MAX_REPLIES_PER_SENDER_PER_DAY) {
    return { intent: intent.kind, query, kind: "none", text: "", sent: false };
  }

  let receipt: Receipt;
  let preface: string[] = [];

  switch (intent.kind) {
    case "lookup": {
      receipt = (await buildReceipt(ctx.db, intent.query)).receipt;
      if (receipt.kind === "none" && looksLikeAddress(intent.query)) {
        // A building we don't hold yet: start pulling it from the city now.
        await ctx.scheduler.runAfter(0, internal.ingest.seed.resolveAddress, { q: intent.query, inboxId });
        receipt = {
          ...receipt,
          headline: `We don't hold ${intent.query} yet — we're pulling this building's records from the city now.`,
          blocks: [["Ask again in a few minutes for the receipt. Reply FOLLOW and we'll email you when this building's records change."]],
        };
      }
      break;
    }
    case "letter": {
      const guess = await guessCompanyFromText(ctx.db, intent.text);
      if (guess) {
        receipt = (await buildReceipt(ctx.db, guess)).receipt;
        preface = [`We read your letter as being about ${guess}. If that's wrong, reply with the company's name.`];
      } else {
        receipt = {
          ...noMatchReceipt("your letter", []),
          headline: "We couldn't tell which employer your letter is about.",
          blocks: [["Reply with the company's name as it appears on your paperwork, and we'll send the receipt."]],
        };
      }
      break;
    }
    case "follow": {
      const prior = await latestMatchedInThread(ctx, threadId);
      if (prior) {
        await upsertSubscription(ctx, prior.matchedSubjectKey!, from, threadId, now);
        receipt = {
          kind: "none",
          query: "follow",
          subjectKey: prior.matchedSubjectKey,
          headline: `You're following ${prior.query}.`,
          blocks: [["We'll email this thread if the filing changes — a new version, a changed date, or the row leaving the file.", "Reply STOP to stop."]],
          links: [],
          footer: [],
        };
      } else {
        receipt = {
          kind: "none",
          query: "follow",
          headline: "Reply FOLLOW to a receipt we sent you, and we'll follow that filing for you.",
          blocks: [["Or send a company name or a building address to get a receipt first."]],
          links: [],
          footer: [],
        };
      }
      break;
    }
    case "stop": {
      const subs = await ctx.db.query("subscriptions").withIndex("by_email", (q) => q.eq("email", from)).collect();
      for (const s of subs) if (s.active) await ctx.db.patch(s._id, { active: false });
      receipt = { kind: "none", query: "stop", headline: "Stopped. We won't email you again unless you ask.", blocks: [], links: [], footer: [] };
      break;
    }
    default: {
      receipt = {
        kind: "none",
        query: "",
        headline: "Send a company name, or a building address, and we'll send back what they filed.",
        blocks: [["For example: Spirit Airlines. Or: 249 East 37 Street, Brooklyn."]],
        links: [],
        footer: [],
      };
    }
  }

  const withPreface: Receipt = preface.length ? { ...receipt, blocks: [preface, ...receipt.blocks] } : receipt;
  const text = receiptText(withPreface);
  const html = receiptHtml(withPreface);

  const receiptId = await ctx.db.insert("receipts", {
    inboxId,
    threadId: threadId || undefined,
    query: receipt.query,
    kind: receipt.kind,
    subjectKey: receipt.subjectKey,
    text,
    html,
    createdAt: now,
  });
  if (receipt.subjectKey) await ctx.db.patch(inboxId, { matchedSubjectKey: receipt.subjectKey });

  let sent = false;
  if (process.env.AGENTMAIL_API_KEY && m.inbox_id) {
    const outboundId = await agentmail.replyToMessage(ctx as any, String(m.inbox_id), messageId, { text, html });
    await ctx.db.patch(receiptId, { outboundId: String(outboundId) });
    await ctx.db.patch(inboxId, { replied: true });
    sent = true;
  } else {
    console.log(`[inbound] receipt stored, not sent (no AgentMail key) — ${intent.kind} "${query}"`);
  }

  return { intent: intent.kind, query, kind: receipt.kind, text, sent };
}

async function latestMatchedInThread(ctx: MutationCtx, threadId: string) {
  if (!threadId) return null;
  const rows = await ctx.db.query("inbox").withIndex("by_thread", (q) => q.eq("threadId", threadId)).order("desc").take(10);
  return rows.find((r) => r.matchedSubjectKey) ?? null;
}

async function upsertSubscription(ctx: MutationCtx, subjectKey: string, email: string, threadId: string, now: number) {
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_email", (q) => q.eq("email", email).eq("subjectKey", subjectKey))
    .unique();
  if (existing) {
    if (!existing.active) await ctx.db.patch(existing._id, { active: true, threadId });
    return;
  }
  await ctx.db.insert("subscriptions", { subjectKey, email, threadId, createdAt: now, active: true });
}
