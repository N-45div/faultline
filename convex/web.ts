import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { handleInbound } from "./inbound";
import { limits } from "./limits";
import { paused } from "./guard";
import { classifyInbound } from "../engine/intent";
import { looksLikeAddress } from "../engine/match";
import { validSession, webIdentity, WEB_CHANNEL } from "../engine/web";
import { forSpeech } from "../engine/speech";
import { LIVE_MAX_SECONDS, liveCents, spokenToTyped } from "../engine/live";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

// The browser trial: the inbox, without the email.
//
// A message typed on /try goes through the same handler an email does -
// the same keyword reader, the same agent, the same tools writing the reply -
// and the reply is a row this page holds a live query on, so it appears the
// moment the mutation that wrote it commits. No account, no mailbox.
//
// It is a public door onto things that cost money and database reads, so it
// pays at the door from rooms of its own (convex/limits.ts): nothing typed
// into a browser can spend the inbox's replies or its agent runs.

const INBOX = () => process.env.AGENTMAIL_INBOX_ID ?? "getnotice@agentmail.to";

export const say = mutation({
  args: {
    /** Made and kept in the browser; the only key to this thread. */
    session: v.string(),
    /** The browser's own id for this message, so it can lay its words beside our reply. */
    id: v.string(),
    text: v.string(),
    /** Set by the page when the words came out of a conversation with gpt-live-1. */
    live: v.optional(v.boolean()),
  },
  returns: v.object({ ok: v.boolean(), why: v.string() }),
  handler: async (ctx, { live, ...a }) => {
    if (!live) return await through(ctx, a);
    // Believed only while a conversation our own server started is open for this browser.
    if (!(await openLive(ctx, a.session))) return { ok: false, why: "That conversation has ended. Start another, or type it." };
    const out = await through(ctx, { ...a, text: spokenToTyped(a.text) });
    if (out.ok) {
      const row = await ctx.db.query("inbox").withIndex("by_message_id", (q) => q.eq("messageId", `web:${a.session}:${a.id}`)).unique();
      if (row) await ctx.db.patch(row._id, { heardBy: "gpt-live-1" });
    }
    return out;
  },
});

/** The conversation this browser has open, if our server started one and has not ended it. */
async function openLive(ctx: MutationCtx, session: string): Promise<Doc<"liveSessions"> | null> {
  if (!validSession(session)) return null;
  const last = await ctx.db.query("liveSessions").withIndex("by_session", (q) => q.eq("session", session)).order("desc").first();
  if (!last || last.endedAt !== undefined || Date.now() - last.createdAt > (LIVE_MAX_SECONDS + 40) * 1000) return null;
  return last;
}

/** A conversation has been made. It is given its end now: the server closes it if the page has not. */
export const liveStarted = internalMutation({
  args: { session: v.string(), liveId: v.string() },
  returns: v.null(),
  handler: async (ctx, { session, liveId }) => {
    const row = await ctx.db.insert("liveSessions", { session, liveId, createdAt: Date.now() });
    await ctx.scheduler.runAfter((LIVE_MAX_SECONDS + 10) * 1000, internal.liveActions.hangUp, { row });
    return null;
  },
});

export const liveRow = internalQuery({
  args: { row: v.id("liveSessions") },
  returns: v.union(v.null(), v.object({ liveId: v.string(), ended: v.boolean() })),
  handler: async (ctx, { row }) => {
    const r = await ctx.db.get(row);
    return r ? { liveId: r.liveId, ended: r.endedAt !== undefined } : null;
  },
});

/** Ended, and priced: by the page when the person stops, or by the server when the time is up. */
async function endLive(ctx: MutationCtx, r: Doc<"liveSessions">, seconds: number | undefined, endedBy: string): Promise<void> {
  if (r.endedAt !== undefined) return;
  // A count of seconds is believed only up to what the clock allows. (Our clock starts when OpenAI
  // has answered, a few seconds after theirs.)
  const elapsed = Math.ceil((Date.now() - r.createdAt) / 1000) + 5;
  const billed = Math.max(0, Math.min(seconds ?? elapsed, elapsed, LIVE_MAX_SECONDS + 30));
  await ctx.db.patch(r._id, { endedAt: Date.now(), seconds: billed, endedBy });
  await ctx.runMutation(internal.llm.recordUsage, { model: "gpt-live-1", purpose: "live", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCents: liveCents(billed) });
}

export const liveClosed = internalMutation({
  args: { row: v.id("liveSessions"), seconds: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { row, seconds }) => {
    const r = await ctx.db.get(row);
    if (r) await endLive(ctx, r, seconds, "the server, at the time limit");
    return null;
  },
});

export const liveEnded = mutation({
  args: { session: v.string(), liveId: v.string(), seconds: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { session, liveId, seconds }) => {
    const r = await openLive(ctx, session);
    if (r && r.liveId === liveId) await endLive(ctx, r, seconds, "the page");
    return null;
  },
});

/**
 * The same door, for words that arrived as speech (convex/voice.ts). Internal:
 * only our own transcription may say a message was heard, and by what.
 */
export const sayHeard = internalMutation({
  args: { session: v.string(), id: v.string(), text: v.string(), heardBy: v.string() },
  returns: v.object({ ok: v.boolean(), why: v.string() }),
  handler: async (ctx, { heardBy, ...a }) => {
    const out = await through(ctx, a);
    if (out.ok) {
      const row = await ctx.db.query("inbox").withIndex("by_message_id", (q) => q.eq("messageId", `web:${a.session}:${a.id}`)).unique();
      if (row) await ctx.db.patch(row._id, { heardBy });
    }
    return out;
  },
});

/** Room to hear a recording or to read a reply aloud, taken before any model is called. */
export const allowVoice = internalMutation({
  args: { session: v.string(), what: v.union(v.literal("hear"), v.literal("speak"), v.literal("live")) },
  returns: v.object({ ok: v.boolean(), why: v.string() }),
  handler: async (ctx, { session, what }) => {
    if (!validSession(session)) return { ok: false, why: "This page lost its place. Reload it and try again." };
    if (paused("web") || paused("llm") || (what === "live" && paused("live"))) return { ok: false, why: `Voice is paused. Typing works, and so does the inbox: ${INBOX()}.` };
    const mine = await limits.limit(ctx, what === "hear" ? "webHearSender" : what === "speak" ? "webSpeakSender" : "webLiveSender", { key: session });
    if (!mine.ok) return { ok: false, why: what === "live" ? "That is a day's worth of conversations for one browser. Say it or type it instead." : "That is a day's worth of voice for one browser. Typing still works." };
    const all = await limits.limit(ctx, what === "hear" ? "webHear" : what === "speak" ? "webSpeak" : "webLive");
    if (!all.ok) return { ok: false, why: "The browser trial has used its voice for today. Typing still works." };
    return { ok: true, why: "" };
  },
});

/**
 * One of our replies, made sayable - and only for the browser whose thread it
 * is in. What is read aloud is what the tool wrote; nothing is composed here.
 */
export const spokenReply = internalQuery({
  args: { session: v.string(), replyId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { session, replyId }) => {
    if (!validSession(session)) return null;
    const id = ctx.db.normalizeId("receipts", replyId);
    if (!id) return null;
    const reply = await ctx.db.get(id);
    if (!reply || reply.threadId !== `web:${session}`) return null;
    return forSpeech(reply.text);
  },
});

async function through(ctx: MutationCtx, { session, id, text }: { session: string; id: string; text: string }): Promise<{ ok: boolean; why: string }> {
  {
    if (!validSession(session) || !/^[a-f0-9]{8,32}$/.test(id)) return { ok: false, why: "This page lost its place. Reload it and try again." };
    const words = text.replace(/\r/g, "").trim().slice(0, 600);
    if (words.length < 2) return { ok: false, why: "Write something first." };
    if (paused("web")) return { ok: false, why: `The browser trial is paused. The inbox works the same way: ${INBOX()}.` };

    const mine = await limits.limit(ctx, "webSender", { key: session });
    if (!mine.ok) return { ok: false, why: `That is a day's worth of messages for one browser. By email there is more room: ${INBOX()}.` };
    const all = await limits.limit(ctx, "webAll");
    if (!all.ok) return { ok: false, why: `The browser trial has had its day's worth of messages. The inbox works the same way: ${INBOX()}.` };
    // Asking about a building reads every row we hold for it, and an address
    // we have never seen starts a read of the city's file.
    // The sample building answers from one small row (wall.refreshSampleAsk),
    // so the first button on the page does not spend this.
    const intent = classifyInbound("", words);
    const sample = /\b155\s+linden\b/i.test(words);
    if (!sample && (intent.kind === "ask" || (intent.kind === "lookup" && looksLikeAddress(intent.query)))) {
      const asks = await limits.limit(ctx, "webAsk");
      if (!asks.ok) return { ok: false, why: `The browser trial has looked up its buildings for today. By email it works the same way: ${INBOX()}.` };
    }

    await handleInbound(
      ctx,
      {
        message_id: `web:${session}:${id}`,
        thread_id: `web:${session}`,
        inbox_id: WEB_CHANNEL,
        from: webIdentity(session),
        subject: "",
        text: words,
      },
      true,
    );
    return { ok: true, why: "" };
  }
}

/**
 * The thread, live. Our replies in full, and for each message of theirs how it
 * was read - by the keyword reader or by the model, and then which tool
 * answered and what the run cost. Their own words are not here: the browser
 * keeps them, and lays them in by id.
 */
export const thread = query({
  args: { session: v.string() },
  returns: v.array(
    v.object({
      id: v.string(),
      at: v.number(),
      who: v.union(v.literal("you"), v.literal("faultline"), v.literal("call"), v.literal("live")),
      text: v.string(),
      read: v.optional(v.string()),
      heard: v.optional(v.string()),
      tool: v.optional(v.string()),
      cents: v.optional(v.number()),
      answered: v.optional(v.boolean()),
      /** For a phone call: where it stands, the last four digits rung, and what was said. */
      status: v.optional(v.string()),
      tail: v.optional(v.string()),
      turns: v.optional(v.array(v.object({ who: v.string(), text: v.string() }))),
      readBy: v.optional(v.string()),
      unsure: v.optional(v.array(v.string())),
      /** For a finished conversation: how long gpt-live-1 was open. */
      seconds: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { session }) => {
    if (!validSession(session)) return [];
    const threadId = `web:${session}`;
    const theirs = await ctx.db.query("inbox").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(80);
    const ours = await ctx.db.query("receipts").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(160);
    const calls = await ctx.db.query("calls").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(10);
    const talks = await ctx.db.query("liveSessions").withIndex("by_session", (q) => q.eq("session", session)).order("desc").take(6);
    const prefix = `${threadId}:`;
    return [
      ...talks
        .filter((l) => l.endedAt !== undefined)
        .map((l) => ({ id: String(l._id), at: l.endedAt ?? l.createdAt, who: "live" as const, text: "", seconds: l.seconds ?? 0, cents: liveCents(l.seconds ?? 0), status: l.endedBy ?? "" })),
      ...calls.map((c) => ({
        id: String(c._id),
        at: c.createdAt + 1,
        who: "call" as const,
        text: "",
        status: c.status,
        tail: c.tail,
        ...(c.turns ? { turns: c.turns } : {}),
        ...(c.readBy ? { readBy: c.readBy } : {}),
        ...(c.readCents !== undefined ? { cents: c.readCents } : {}),
        ...(c.unsure ? { unsure: c.unsure } : {}),
      })),
      ...theirs.map((m) => ({
        id: m.messageId.startsWith(prefix) ? m.messageId.slice(prefix.length) : m.messageId,
        at: m.receivedAt,
        who: "you" as const,
        // Typed words are kept by the browser that typed them. An answer taken
        // on a call was typed by nobody, so it comes from here.
        text: m.said ?? "",
        read: m.intent,
        ...(m.heardBy ? { heard: m.heardBy } : {}),
        ...(m.agentTool ? { tool: m.agentTool } : {}),
        ...(m.agentCents !== undefined ? { cents: m.agentCents } : {}),
        answered: m.replied,
      })),
      ...ours.map((r) => ({ id: String(r._id), at: r.createdAt, who: "faultline" as const, text: r.text })),
    ].sort((a, b) => a.at - b.at);
  },
});
