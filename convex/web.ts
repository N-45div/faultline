import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { handleInbound } from "./inbound";
import { limits } from "./limits";
import { paused } from "./guard";
import { classifyInbound } from "../engine/intent";
import { looksLikeAddress } from "../engine/match";
import { validSession, webIdentity, WEB_CHANNEL } from "../engine/web";

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
  handler: async (ctx, { session, id, text }) => {
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
    const intent = classifyInbound("", words);
    if (intent.kind === "ask" || (intent.kind === "lookup" && looksLikeAddress(intent.query))) {
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
  },
});

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
        ...(m.agentTool ? { tool: m.agentTool } : {}),
        ...(m.agentCents !== undefined ? { cents: m.agentCents } : {}),
        answered: m.replied,
      })),
      ...ours.map((r) => ({ id: String(r._id), at: r.createdAt, who: "faultline" as const, text: r.text })),
    ].sort((a, b) => a.at - b.at);
  },
});
