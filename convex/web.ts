import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { handleInbound } from "./inbound";
import { limits } from "./limits";
import { paused } from "./guard";
import { classifyInbound } from "../engine/intent";
import { looksLikeAddress } from "../engine/match";
import { validSession, webIdentity, WEB_CHANNEL } from "../engine/web";
import { forSpeech } from "../engine/speech";

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
  },
  returns: v.object({ ok: v.boolean(), why: v.string() }),
  handler: async (ctx, a) => await through(ctx, a),
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
  args: { session: v.string(), what: v.union(v.literal("hear"), v.literal("speak")) },
  returns: v.object({ ok: v.boolean(), why: v.string() }),
  handler: async (ctx, { session, what }) => {
    if (!validSession(session)) return { ok: false, why: "This page lost its place. Reload it and try again." };
    if (paused("web") || paused("llm")) return { ok: false, why: `Voice is paused. Typing works, and so does the inbox: ${INBOX()}.` };
    const mine = await limits.limit(ctx, what === "hear" ? "webHearSender" : "webSpeakSender", { key: session });
    if (!mine.ok) return { ok: false, why: "That is a day's worth of voice for one browser. Typing still works." };
    const all = await limits.limit(ctx, what === "hear" ? "webHear" : "webSpeak");
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
      who: v.union(v.literal("you"), v.literal("faultline")),
      text: v.string(),
      read: v.optional(v.string()),
      heard: v.optional(v.string()),
      tool: v.optional(v.string()),
      cents: v.optional(v.number()),
      answered: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx, { session }) => {
    if (!validSession(session)) return [];
    const threadId = `web:${session}`;
    const theirs = await ctx.db.query("inbox").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(80);
    const ours = await ctx.db.query("receipts").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(160);
    const prefix = `${threadId}:`;
    return [
      ...theirs.map((m) => ({
        id: m.messageId.startsWith(prefix) ? m.messageId.slice(prefix.length) : m.messageId,
        at: m.receivedAt,
        who: "you" as const,
        text: "",
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
