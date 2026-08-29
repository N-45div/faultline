import { v } from "convex/values";
import { query } from "./_generated/server";
import { noticeSentence, warnNoticeGap } from "../engine/rules";

// Public, unauthenticated reads. Nothing here touches a model or a network.

/** The wall: what moved, per publisher, bounded, newest first. */
export const recent = query({
  args: {},
  returns: v.array(v.object({ sentence: v.string(), sourceUrl: v.string(), at: v.number(), slug: v.string() })),
  handler: async (ctx) => {
    const sources = await ctx.db.query("sources").collect();
    const out: { sentence: string; sourceUrl: string; at: number; slug: string }[] = [];
    for (const s of sources) {
      const rows = await ctx.db
        .query("recentChanges")
        .withIndex("by_source", (q) => q.eq("sourceId", s._id))
        .order("desc")
        .take(20);
      for (const r of rows) out.push({ sentence: r.sentence, sourceUrl: r.sourceUrl, at: r.createdAt, slug: s.slug });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 30);
  },
});

const noticeRow = v.object({
  company: v.string(),
  site: v.string(),
  workers: v.number(),
  noticeDate: v.string(),
  effectiveDate: v.string(),
  postedDate: v.string(),
  actualDays: v.number(),
  postingLagDays: v.number(),
  sentence: v.string(),
});

/**
 * The state's layoff file as it stands, read from the rows we hold. The
 * statistic the product exists for is recomputed on every read.
 */
export const layoffNotices = query({
  args: { slug: v.union(v.literal("ny-warn"), v.literal("ca-warn")) },
  returns: v.object({
    total: v.number(),
    underStatute: v.number(),
    zeroDays: v.number(),
    postedAfterStart: v.number(),
    statutoryDays: v.number(),
    lastCheckedAt: v.optional(v.number()),
    shortest: v.array(noticeRow),
  }),
  handler: async (ctx, { slug }) => {
    const jurisdiction = slug === "ny-warn" ? "US-NY" : "US-CA";
    const stateName = slug === "ny-warn" ? "New York" : "California";
    const s = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    const statutoryDays = warnNoticeGap({ jurisdiction, noticeDate: "2026-01-01", effectiveDate: "2026-01-01" }).statutoryDays;
    if (!s) return { total: 0, underStatute: 0, zeroDays: 0, postedAfterStart: 0, statutoryDays, shortest: [] };

    const rows = await ctx.db
      .query("current")
      .withIndex("by_source_identity", (q) => q.eq("sourceId", s._id))
      .collect();

    const scored = rows.map((r) => {
      const f = r.fields;
      const postedDate = String(f.postedDate ?? f.processedDate ?? "");
      const g = warnNoticeGap({
        jurisdiction,
        noticeDate: String(f.noticeDate),
        effectiveDate: String(f.effectiveDate),
        postedDate: postedDate || undefined,
      });
      const workers = Number(f.employeesAffected) || 0;
      return {
        company: String(f.company),
        site: String(f.siteAddress),
        workers,
        noticeDate: String(f.noticeDate),
        effectiveDate: String(f.effectiveDate),
        postedDate,
        actualDays: g.actualDays,
        postingLagDays: g.postingLagDays ?? 0,
        sentence: noticeSentence(String(f.company), workers, String(f.siteAddress), g, stateName),
        _gap: g,
      };
    });

    const shortest = scored
      .filter((r) => r._gap.verdict === "gap")
      .sort((a, b) => a.actualDays - b.actualDays || b.workers - a.workers)
      .slice(0, 5)
      .map(({ _gap, ...r }) => r);

    return {
      total: scored.length,
      underStatute: scored.filter((r) => r._gap.verdict === "gap").length,
      zeroDays: scored.filter((r) => r.actualDays <= 0).length,
      postedAfterStart: scored.filter((r) => r._gap.postedAfterEffective).length,
      statutoryDays,
      lastCheckedAt: s.lastRunAt,
      shortest,
    };
  },
});

/** When each publisher's file was last read. Labels, never internal names. */
export const lastChecked = query({
  args: {},
  returns: v.array(v.object({ label: v.string(), at: v.optional(v.number()) })),
  handler: async (ctx) => {
    const labels: Record<string, string> = {
      "ny-warn": "New York layoff filings",
      "ca-warn": "California layoff filings",
      "nyc-hpd": "NYC housing violations",
    };
    const sources = await ctx.db.query("sources").collect();
    return sources.map((s) => ({ label: labels[s.slug] ?? s.slug, at: s.lastRunAt }));
  },
});
