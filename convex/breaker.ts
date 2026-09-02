import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { pausedSet } from "./guard";

// Circuit breakers for the providers we pay or depend on. Three failures in
// a row open the breaker for fifteen minutes; while it is open the caller
// does not try, and says so ("we didn't look"), instead of burning a retry
// budget against a provider that is down or a key that was revoked. The
// first call after the cool-off is the probe: one success closes it.

export type Provider = "openai" | "agentmail";
const THRESHOLD = 3;
const COOL_MS = 15 * 60_000;

export const open = internalQuery({
  args: { provider: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { provider }) => {
    const row = await ctx.db.query("breakers").withIndex("by_provider", (q) => q.eq("provider", provider)).unique();
    return Boolean(row && row.openedUntil > Date.now());
  },
});

export const record = internalMutation({
  args: { provider: v.string(), ok: v.boolean(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { provider, ok, error }) => {
    const now = Date.now();
    const row = await ctx.db.query("breakers").withIndex("by_provider", (q) => q.eq("provider", provider)).unique();
    if (ok) {
      if (row && (row.failures > 0 || row.openedUntil > 0)) await ctx.db.patch(row._id, { failures: 0, openedUntil: 0, updatedAt: now });
      else if (!row) await ctx.db.insert("breakers", { provider, failures: 0, openedUntil: 0, updatedAt: now });
      return null;
    }
    const failures = (row?.failures ?? 0) + 1;
    const openedUntil = failures >= THRESHOLD ? now + COOL_MS : (row?.openedUntil ?? 0);
    const patch = { failures, openedUntil, lastError: (error ?? "").slice(0, 200), updatedAt: now };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("breakers", { provider, ...patch });
    if (failures >= THRESHOLD) console.error(`[breaker] ${provider} open until ${new Date(openedUntil).toISOString()} after ${failures} failures: ${error ?? ""}`);
    return null;
  },
});

/** What is switched off right now, for the page that says so. */
export const status = query({
  args: {},
  returns: v.object({
    paused: v.array(v.string()),
    breakers: v.array(v.object({ provider: v.string(), failures: v.number(), openUntil: v.union(v.number(), v.null()), lastError: v.optional(v.string()) })),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("breakers").collect();
    return {
      paused: [...pausedSet()],
      breakers: rows
        .filter((r) => r.failures > 0 || r.openedUntil > now)
        .map((r) => ({ provider: r.provider, failures: r.failures, openUntil: r.openedUntil > now ? r.openedUntil : null, lastError: r.lastError })),
    };
  },
});
