import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { daysBetween, fnv1a64 } from "../engine/canon";
import { skipReason } from "../engine/hygiene";
import { looksLikeAddress } from "../engine/match";
import { classifyInbound, emailAddressOf, stripHtml } from "../engine/intent";
import { complianceLines, noMatchReceipt, receiptHtml, receiptText, type Receipt } from "../engine/receipt";
import { buildReceipt, guessCompanyFromText } from "./lookup";

// The address is a search box that writes back. Everything a person can do by
// email lands here, is classified without a model, and is answered in-thread.
// A pasted letter is the one path that goes through the model, asynchronously.

const MAX_REPLIES_PER_SENDER_PER_DAY = 20;
/** Reputation guard: past this, mail is stored and answered by a person later. */
const MAX_REPLIES_PER_DAY = 150;

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
  pending?: boolean;
}

interface Target {
  inboxId: Id<"inbox">;
  messageId: string;
  agentInboxId: string;
  threadId: string;
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
  const bodyHash = fnv1a64(body);

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
    bodyHash,
    replied: false,
  });
  const target: Target = { inboxId, messageId, agentInboxId: String(m.inbox_id ?? ""), threadId };

  // STOP is honoured before every gate below it. A person who wants us to go
  // away may well be mailing from an address that fails SPF, or mailing for the
  // twenty-first time today — exactly the cases the gates drop. Whether we send
  // a confirmation is a separate question, and the gates still decide that.
  if (intent.kind === "stop") await unsubscribe(ctx, from, now);

  // Never answer a robot: bounces, lists, auto-responders, our own address.
  // The message is stored above either way; we just don't send.
  const skip = skipReason(from, String(process.env.AGENTMAIL_INBOX_ID ?? ""), m.headers);
  if (skip) {
    console.log(`[inbound] stored, not answered: ${skip}`);
    return { intent: intent.kind, query, kind: "none", text: "", sent: false };
  }

  // Politeness ceilings: per sender, and a global one for the inbox's
  // reputation. Unauthenticated mail is stored, never answered.
  const recent = await ctx.db
    .query("inbox")
    .withIndex("by_from", (q) => q.eq("fromAddress", from).gte("receivedAt", now - 86_400_000))
    .collect();
  const sentToday = await ctx.db
    .query("receipts")
    .withIndex("by_created", (q) => q.gte("createdAt", now - 86_400_000))
    .take(MAX_REPLIES_PER_DAY + 1);
  if (!authenticated || recent.length > MAX_REPLIES_PER_SENDER_PER_DAY || sentToday.length > MAX_REPLIES_PER_DAY) {
    return { intent: intent.kind, query, kind: "none", text: "", sent: false };
  }

  // A PDF attachment is a letter, whatever the body says — "see attached" is
  // how real people send these. The model reads the file directly.
  const attachments: any[] = Array.isArray(m.attachments) ? m.attachments : [];
  const pdfAtt = attachments.find(
    (a) => /pdf/i.test(String(a?.content_type ?? "")) || /\.pdf$/i.test(String(a?.filename ?? "")),
  );
  const pdfAttachmentId = String(pdfAtt?.attachment_id ?? pdfAtt?.id ?? "");
  if (pdfAtt && pdfAttachmentId && process.env.OPENAI_API_KEY && ["lookup", "letter", "empty"].includes(intent.kind)) {
    // "see attached" bodies say nothing; the subject is often the only place
    // the employer is named, so it travels with the letter.
    const withSubject = [subject, body].filter(Boolean).join(String.fromCharCode(10));
    const h = fnv1a64(`${withSubject}|${pdfAttachmentId}`);
    await ctx.db.patch(inboxId, { intent: "letter", bodyHash: h });
    await ctx.scheduler.runAfter(0, internal.llmActions.extractLetter, {
      inboxId,
      text: withSubject.slice(0, 12_000),
      bodyHash: h,
      attachment: {
        agentInboxId: target.agentInboxId,
        messageId,
        attachmentId: pdfAttachmentId,
        filename: String(pdfAtt.filename ?? "letter.pdf"),
      },
    });
    return { intent: "letter", query: "letter", kind: "none", text: "", sent: false, pending: true };
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
      if (process.env.OPENAI_API_KEY) {
        // The model reads it once (or the cache does); the reply follows in seconds.
        await ctx.scheduler.runAfter(0, internal.llmActions.extractLetter, { inboxId, text: intent.text.slice(0, 12_000), bodyHash });
        return { intent: "letter", query, kind: "none", text: "", sent: false, pending: true };
      }
      const guess = await guessCompanyFromText(ctx.db, intent.text);
      receipt = guess ? (await buildReceipt(ctx.db, guess)).receipt : couldNotTell();
      if (guess) preface = [`We read your letter as being about ${guess}. If that's wrong, reply with the company's name.`];
      break;
    }
    case "follow": {
      const prior = await latestMatchedInThread(ctx, threadId);
      if (prior) {
        await upsertSubscription(ctx, prior.matchedSubjectKey!, from, threadId, messageId, now);
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
    case "pack": {
      // A real pack, built now, delivered to this thread as a PDF.
      const base = intent.query ? (await buildReceipt(ctx.db, intent.query)).receipt : null;
      if (base && base.kind !== "none" && base.subjectKey) {
        await ctx.scheduler.runAfter(0, internal.packs.request, {
          subjectKey: base.subjectKey,
          query: intent.query,
          kind: base.kind,
          requestedBy: from,
          agentInboxId: target.agentInboxId,
          messageId,
          threadId,
        });
        receipt = {
          kind: base.kind,
          query: `pack:${intent.query}`,
          subjectKey: base.subjectKey,
          headline: `Building your evidence pack for ${intent.query} now.`,
          blocks: [
            [
              "It's a PDF: the record as it stands, every dated version we hold with its capture time and hash, the changes we recorded, and the statute — the thing you hand a lawyer.",
              "It will arrive in this thread within a couple of minutes.",
            ],
            ["This preview pack is free while we launch. Packs are $79 once payments open."],
          ],
          links: base.links,
          footer: [],
        };
      } else {
        receipt = {
          kind: "none",
          query: `pack:${intent.query}`,
          headline: intent.query
            ? `We couldn't find "${intent.query}" in the files we hold, so there's nothing to pack yet.`
            : "Evidence pack requested — reply with the company name or building address it's for.",
          blocks: [
            [
              "An evidence pack is a PDF: every dated version of the filing we hold, capture times and hashes, the statute text, and the intervals — the thing you hand a lawyer.",
              intent.query ? "Try the company's legal name as it appears on your paperwork, with PACK in front of it." : "For example: PACK Spirit Airlines.",
            ],
          ],
          links: [],
          footer: ["No card needed to ask."],
        };
      }
      break;
    }
    case "monitor": {
      receipt = {
        kind: "none",
        query: "monitor",
        headline: "Monitor: unlimited follows for your team, a weekly digest of what changed, packs included.",
        blocks: [
          ["$199 a month for an organisation, up to five people. $499 with CSV and API access across every state we cover.", "Reply with your organisation's name and the employers or buildings you watch, and we'll set it up and email this thread."],
        ],
        links: [],
        footer: ["No card needed to ask. Reply STOP to withdraw the request."],
      };
      break;
    }
    case "stop": {
      // Already done above, before the gates. This only confirms it.
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

  const delivered = await deliver(ctx, target, receipt, preface);
  return { intent: intent.kind, query, kind: receipt.kind, text: delivered.text, sent: delivered.sent };
}

/** Second half of the letter path: the model (or the cache) has spoken. */
export const finishLetter = internalMutation({
  args: { inboxId: v.id("inbox"), text: v.string(), extraction: v.any(), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { inboxId, text, extraction, note }) => {
    const row = await ctx.db.get(inboxId);
    if (!row || row.replied) return null;
    const x = extraction && typeof extraction === "object" ? (extraction as Record<string, any>) : null;

    const company: string | null = (x?.employer && String(x.employer)) || (await guessCompanyFromText(ctx.db, text));
    const receipt = company ? (await buildReceipt(ctx.db, company)).receipt : couldNotTell();

    // A file that is not a termination letter comes back as every field null,
    // exactly as the model was told to. Saying "What your letter says:" over
    // nothing is worse than not saying it.
    const said =
      x &&
      (x.quotedClaim || x.noticeDate || x.lastDay || x.signDeadlineDays || x.severanceOffered || (x.owbpaDisclosureAttached && x.owbpaDisclosureAttached !== "unclear"));

    const preface: string[] = [];
    if (x && said) {
      preface.push("What your letter says:");
      if (x.quotedClaim) preface.push(`“${String(x.quotedClaim).trim()}”`);
      if (x.noticeDate && x.lastDay) {
        const n = daysBetween(String(x.noticeDate), String(x.lastDay));
        preface.push(`Letter dated ${x.noticeDate}; last day ${x.lastDay} — ${n} ${n === 1 ? "day" : "days"} between them.`);
      } else if (x.lastDay) {
        preface.push(`Last day: ${x.lastDay}.`);
      }
      if (x.signDeadlineDays) preface.push(`You were given ${x.signDeadlineDays} days to sign the release.`);
      if (x.owbpaDisclosureAttached === "no") {
        preface.push(
          "Your letter does not appear to include the list of job titles and ages that a group termination must give anyone 40 or over (OWBPA). If you are 40 or over, that list should have come with the release, and you get 45 days to consider it — a lawyer will want to know.",
        );
      } else if (x.owbpaDisclosureAttached === "yes") {
        preface.push("Your letter says the OWBPA list of job titles and ages is attached — keep it with the release.");
      }
      if (company && receipt.kind !== "none") preface.push(`What ${company} filed with the state:`);
      else if (company) preface.push(`We read your letter as being about ${company}, but we don't hold a filing for them yet.`);
    } else if (company) {
      preface.push(`We read your letter as being about ${company}. If that's wrong, reply with the company's name.`);
    } else if (x) {
      preface.push("We couldn't read that as a termination, layoff or separation letter.");
    }
    if (note === "budget") preface.push("We've hit today's limit for reading letters; this receipt uses only the company name.");
    if (note === "moderation") {
      await deliver(
        ctx,
        { inboxId, messageId: row.messageId, agentInboxId: row.inboxId, threadId: row.threadId },
        {
          kind: "none",
          query: "letter",
          headline: "We can only read termination, layoff, and separation letters.",
          blocks: [["Send a company name or a New York City building address, and we'll send back what they filed."]],
          links: [],
          footer: [],
        },
        [],
      );
      return null;
    }

    await deliver(ctx, { inboxId, messageId: row.messageId, agentInboxId: row.inboxId, threadId: row.threadId }, receipt, preface);
    return null;
  },
});

async function deliver(ctx: MutationCtx, t: Target, receipt: Receipt, preface: string[]): Promise<{ text: string; sent: boolean }> {
  // On everything we send: who we are, why it arrived, and how to stop it.
  const postal = (process.env.NOTICE_POSTAL ?? "").trim();
  if (!postal) console.warn("[inbound] NOTICE_POSTAL is unset — outbound mail carries no postal address");
  const compliance = receipt.query === "stop" ? [] : complianceLines(postal, "you are getting this because you wrote to this address.");
  const withPreface: Receipt = {
    ...receipt,
    blocks: preface.length ? [preface, ...receipt.blocks] : receipt.blocks,
    footer: [...receipt.footer, ...compliance],
  };
  const text = receiptText(withPreface);
  const html = receiptHtml(withPreface);

  const receiptId = await ctx.db.insert("receipts", {
    inboxId: t.inboxId,
    threadId: t.threadId || undefined,
    query: receipt.query,
    kind: receipt.kind,
    subjectKey: receipt.subjectKey,
    text,
    html,
    createdAt: Date.now(),
  });
  if (receipt.subjectKey) await ctx.db.patch(t.inboxId, { matchedSubjectKey: receipt.subjectKey });

  if (process.env.AGENTMAIL_API_KEY && t.agentInboxId) {
    // Sent from an action with the deployment's key; the component only
    // handles inbound. markSent flips `replied` when AgentMail accepts it.
    await ctx.scheduler.runAfter(0, internal.mail.reply, {
      agentInboxId: t.agentInboxId,
      parentMessageId: t.messageId,
      text,
      html,
      receiptId,
      inboxId: t.inboxId,
    });
    return { text, sent: true };
  }
  console.log(`[inbound] receipt stored, not sent (no inbox on this message) — "${receipt.query}"`);
  return { text, sent: false };
}

function couldNotTell(): Receipt {
  return {
    ...noMatchReceipt("your letter", []),
    headline: "We couldn't tell which employer your letter is about.",
    blocks: [["Reply with the company's name as it appears on your paperwork, and we'll send the receipt."]],
  };
}

/**
 * Every follow off, and anything already queued for them dropped. Called before
 * the gates, so a STOP always lands, however it arrived.
 */
async function unsubscribe(ctx: MutationCtx, email: string, now: number) {
  const subs = await ctx.db.query("subscriptions").withIndex("by_email", (q) => q.eq("email", email)).collect();
  let off = 0;
  for (const s of subs) {
    if (!s.active) continue;
    await ctx.db.patch(s._id, { active: false });
    off++;
  }
  const queued = await ctx.db
    .query("alertQueue")
    .withIndex("by_email_status", (q) => q.eq("email", email).eq("status", "pending"))
    .take(500);
  for (const a of queued) await ctx.db.patch(a._id, { status: "sent", sentAt: now });
  if (off > 0 || queued.length > 0) console.log(`[inbound] STOP honoured: ${off} follows off, ${queued.length} queued alerts dropped`);
}

async function latestMatchedInThread(ctx: MutationCtx, threadId: string) {
  if (!threadId) return null;
  const rows = await ctx.db.query("inbox").withIndex("by_thread", (q) => q.eq("threadId", threadId)).order("desc").take(10);
  return rows.find((r) => r.matchedSubjectKey) ?? null;
}

async function upsertSubscription(ctx: MutationCtx, subjectKey: string, email: string, threadId: string, messageId: string, now: number) {
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_email", (q) => q.eq("email", email).eq("subjectKey", subjectKey))
    .unique();
  if (existing) {
    if (!existing.active || existing.messageId !== messageId) await ctx.db.patch(existing._id, { active: true, threadId, messageId });
    return;
  }
  await ctx.db.insert("subscriptions", { subjectKey, email, threadId, messageId, createdAt: now, active: true });
}
