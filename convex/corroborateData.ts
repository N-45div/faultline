import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { findEmployerSites, noticesFor } from "./lookup";

// The database half of the corroboration path. The search itself lives in
// corroborate.ts, which needs the Node runtime; this side is what remembers,
// so an employer is only ever searched for once per filing date.

const result = {
  corroborated: v.boolean(),
  statementDate: v.union(v.string(), v.null()),
  employerStatement: v.union(v.string(), v.null()),
  speakerOrOutlet: v.union(v.string(), v.null()),
  confidence: v.string(),
  citations: v.array(v.object({ url: v.string(), title: v.string() })),
};

export const cached = internalQuery({
  args: { employer: v.string(), filingDate: v.string() },
  returns: v.union(v.null(), v.object(result)),
  handler: async (ctx, { employer, filingDate }) => {
    const row = await ctx.db
      .query("corroborations")
      .withIndex("by_key", (q) => q.eq("employer", employer).eq("filingDate", filingDate))
      .unique();
    if (!row) return null;
    // A hit is kept for good — the past does not change. A miss is kept only
    // for a day: the employer may not have spoken yet when we looked.
    if (!row.corroborated && row.createdAt < Date.now() - 86_400_000) return null;
    return {
      corroborated: row.corroborated,
      statementDate: row.statementDate,
      employerStatement: row.employerStatement,
      speakerOrOutlet: row.speakerOrOutlet,
      confidence: row.confidence,
      citations: row.citations,
    };
  },
});

/**
 * The search is paid for, and the action that buys it is public. It buys
 * only for a filing we hold — the employer's name and notice date exactly as
 * a state's file has them — so a stranger with the URL cannot spend the day's
 * budget on names of their own.
 */
export const isFiling = internalQuery({
  args: { employer: v.string(), filingDate: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { employer, filingDate }) => {
    const sites = await findEmployerSites(ctx.db, employer);
    const keys = sites.filter((s) => s.company === employer).map((s) => s.subjectKey);
    if (keys.length === 0) return false;
    const rows = await noticesFor(ctx.db, keys);
    return rows.some((r) => r.company === employer && r.noticeDate === filingDate);
  },
});

export const callsToday = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const since = Date.now() - 86_400_000;
    const rows = await ctx.db.query("llmUsage").withIndex("by_created", (q) => q.gte("createdAt", since)).collect();
    return rows.filter((r) => r.purpose === "corroborate").length;
  },
});

export const record = internalMutation({
  args: { employer: v.string(), filingDate: v.string(), subjectKey: v.optional(v.string()), costCents: v.number(), ...result },
  returns: v.null(),
  handler: async (ctx, a) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("corroborations")
      .withIndex("by_key", (q) => q.eq("employer", a.employer).eq("filingDate", a.filingDate))
      .unique();
    const doc = {
      employer: a.employer,
      filingDate: a.filingDate,
      subjectKey: a.subjectKey,
      corroborated: a.corroborated,
      statementDate: a.statementDate,
      employerStatement: a.employerStatement,
      speakerOrOutlet: a.speakerOrOutlet,
      confidence: a.confidence,
      citations: a.citations,
      costCents: a.costCents,
      createdAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("corroborations", doc);
    await ctx.db.insert("llmUsage", {
      model: "gpt-5.6-luna+web_search",
      purpose: "corroborate",
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costCents: a.costCents,
      createdAt: now,
    });
    return null;
  },
});

/**
 * A search already bought for this employer and filing date, shown without a
 * click. Public and read-only: it costs nothing and reveals only what a
 * button press would have.
 */
export const shown = query({
  args: { employer: v.string(), filingDate: v.string() },
  returns: v.union(v.null(), v.object(result)),
  handler: async (ctx, { employer, filingDate }) => {
    const row = await ctx.db
      .query("corroborations")
      .withIndex("by_key", (q) => q.eq("employer", employer).eq("filingDate", filingDate))
      .unique();
    if (!row?.corroborated) return null;
    return {
      corroborated: row.corroborated,
      statementDate: row.statementDate,
      employerStatement: row.employerStatement,
      speakerOrOutlet: row.speakerOrOutlet,
      confidence: row.confidence,
      citations: row.citations,
    };
  },
});
