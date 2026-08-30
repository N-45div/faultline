import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { TableNames } from "./_generated/dataModel";
import { handleInbound } from "./inbound";

// Dev-only. Never exposed publicly.

export const overview = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const count = async (t: TableNames) => (await ctx.db.query(t).collect()).length;
    const latest = await ctx.db.query("changes").order("desc").take(6);
    const snaps = await ctx.db.query("snapshots").order("desc").take(6);
    return {
      sources: await count("sources"),
      targets: await count("targets"),
      subjects: await count("subjects"),
      snapshots: await count("snapshots"),
      observations: await count("observations"),
      current: await count("current"),
      changes: await count("changes"),
      recentChanges: await count("recentChanges"),
      inbox: await count("inbox"),
      receipts: await count("receipts"),
      subscriptions: await count("subscriptions"),
      latestChanges: latest.map((c) => `${c.kind} · ${c.sentence}`),
      latestSnapshots: snaps.map((s) => `${s.httpStatus} rows=${s.rowCount} degraded=${s.degraded} pinned=${Boolean(s.bodyStorageId)}`),
    };
  },
});

/** Replays an inbound email through the real handler without AgentMail. */
export const simulateInbound = internalMutation({
  args: { from: v.string(), subject: v.string(), text: v.optional(v.string()), threadId: v.optional(v.string()), agentInboxId: v.optional(v.string()) },
  returns: v.object({ intent: v.string(), query: v.string(), kind: v.string(), sent: v.boolean(), text: v.string(), pending: v.optional(v.boolean()) }),
  handler: async (ctx, { from, subject, text, threadId, agentInboxId }) => {
    const id = `sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const r = await handleInbound(
      ctx,
      {
        message_id: id,
        thread_id: threadId ?? `simthread-${id}`,
        inbox_id: agentInboxId ?? "",
        from,
        subject,
        text: text ?? "",
        timestamp: new Date().toISOString(),
      },
      true,
    );
    return { intent: r.intent, query: r.query, kind: r.kind, sent: r.sent, text: r.text, pending: r.pending };
  },
});
