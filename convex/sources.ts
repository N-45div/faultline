import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { ADAPTERS } from "../engine/adapters/meta";

/** Idempotent. New sources start in shadow mode: observed, diffed, not emitted. */
export const bootstrap = internalMutation({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const created: string[] = [];
    for (const a of ADAPTERS) {
      const existing = await ctx.db
        .query("sources")
        .withIndex("by_slug", (q) => q.eq("slug", a.id))
        .unique();
      if (existing) {
        if (existing.adapterVersion !== a.version) await ctx.db.patch(existing._id, { adapterVersion: a.version });
        continue;
      }
      await ctx.db.insert("sources", {
        slug: a.id,
        adapterVersion: a.version,
        status: "active",
        emit: false,
        nextRunAt: Date.now(),
        consecutiveFailures: 0,
        shadowCycles: 0,
      });
      created.push(a.id);
    }
    return created;
  },
});

/** Promote out of shadow mode once a source has proven quiet on an unchanged upstream. */
export const setEmit = internalMutation({
  args: { slug: v.string(), emit: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { slug, emit }) => {
    const s = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!s) throw new Error(`no source ${slug}`);
    await ctx.db.patch(s._id, { emit });
    return null;
  },
});

/** Dev tool: make a source due so the next cron tick picks it up. */
export const runNow = internalMutation({
  args: { slug: v.string() },
  returns: v.null(),
  handler: async (ctx, { slug }) => {
    const s = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!s) throw new Error(`no source ${slug}`);
    await ctx.db.patch(s._id, { nextRunAt: 0, lockedUntil: undefined });
    return null;
  },
});

export const status = query({
  args: {},
  returns: v.array(
    v.object({
      slug: v.string(),
      status: v.string(),
      emit: v.boolean(),
      nextRunAt: v.number(),
      lastRunAt: v.optional(v.number()),
      lastStatus: v.optional(v.string()),
      consecutiveFailures: v.number(),
      shadowCycles: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("sources").collect();
    return rows.map((s) => ({
      slug: s.slug,
      status: s.status,
      emit: s.emit,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
      lastStatus: s.lastStatus,
      consecutiveFailures: s.consecutiveFailures,
      shadowCycles: s.shadowCycles,
    }));
  },
});
