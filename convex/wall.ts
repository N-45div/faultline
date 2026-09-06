import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { noticeSentence, warnNoticeGap } from "../engine/rules";

// Public, unauthenticated reads. Nothing here touches a model or a network.

/** What each file is called when a person reads it. */
export const PUBLISHER: Record<string, string> = {
  "ny-warn": "New York",
  "ca-warn": "California",
  "va-warn": "Virginia",
  "nj-warn": "New Jersey",
  "md-warn": "Maryland",
  "nc-warn": "North Carolina",
  "co-warn": "Colorado",
  "nyc-hpd": "NYC housing",
  "nyc-restaurants": "NYC restaurants",
};

/** No one file may take more than this many of the lines on show. */
const PER_SOURCE_ON_WALL = 8;
const WALL_SHOWN = 30;

/**
 * The wall: what moved, newest first, with no one publisher allowed to drown
 * the rest. A city moves hundreds of rows a day and a state moves a few a
 * week; both belong here, and the state's few must stay visible.
 */
export const recent = query({
  args: {},
  returns: v.array(
    v.object({
      sentence: v.string(),
      sourceUrl: v.string(),
      at: v.number(),
      slug: v.string(),
      publisher: v.string(),
      count: v.number(),
      weight: v.number(),
      subjectKey: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const sources = await ctx.db.query("sources").collect();
    const out: { sentence: string; sourceUrl: string; at: number; slug: string; publisher: string; count: number; weight: number; subjectKey?: string }[] = [];
    for (const s of sources) {
      const rows = await ctx.db
        .query("recentChanges")
        .withIndex("by_source", (q) => q.eq("sourceId", s._id))
        .order("desc")
        .take(WALL_CAP_READ);
      // Within one publisher, what matters most rises; then the newest.
      const ranked = rows
        .map((r) => ({
          sentence: r.sentence,
          sourceUrl: r.sourceUrl,
          at: r.createdAt,
          slug: s.slug,
          publisher: PUBLISHER[s.slug] ?? s.slug,
          count: r.count ?? 1,
          weight: r.weight ?? 1,
          subjectKey: r.subjectKey,
        }))
        .sort((a, b) => b.weight - a.weight || b.at - a.at)
        .slice(0, PER_SOURCE_ON_WALL);
      out.push(...ranked);
    }
    return out.sort((a, b) => b.at - a.at).slice(0, WALL_SHOWN);
  },
});

const WALL_CAP_READ = 40;

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
    const sources = await ctx.db.query("sources").collect();
    return sources
      .filter((s) => s.emit)
      .map((s) => ({ label: PUBLISHER[s.slug] ?? s.slug, at: s.lastRunAt }));
  },
});

/**
 * The housing side, counted from what we hold rather than asserted. The city's
 * own status words are the only verdict on this page.
 */
const buildingsShape = v.object({ buildings: v.number(), records: v.number(), since: v.string() });

/**
 * The numbers the landing page shows, read from one small row. They are
 * counters and a short list, never a scan: "records" is the source's own
 * count of the rows it holds, kept by every commit; "buildings" is the number
 * of buildings being watched. `refreshStats` writes the row once an hour.
 */
export const buildings = query({
  args: {},
  returns: buildingsShape,
  handler: async (ctx) => {
    const row = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", "buildings")).unique();
    if (row) return row.value as { buildings: number; records: number; since: string };
    return { buildings: 0, records: 0, since: "" };
  },
});

export const refreshStats = internalMutation({
  args: {},
  returns: buildingsShape,
  handler: async (ctx) => {
    const value = await countBuildings(ctx);
    const row = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", "buildings")).unique();
    if (row) await ctx.db.patch(row._id, { value, updatedAt: Date.now() });
    else await ctx.db.insert("stats", { key: "buildings", value, updatedAt: Date.now() });
    return value;
  },
});

async function countBuildings(ctx: { db: any }): Promise<{ buildings: number; records: number; since: string }> {
  const src = await ctx.db.query("sources").withIndex("by_slug", (q: any) => q.eq("slug", "nyc-hpd")).unique();
  if (!src) return { buildings: 0, records: 0, since: "" };
  const watched = await ctx.db
    .query("targets")
    .withIndex("by_source_active", (q: any) => q.eq("sourceId", src._id).eq("active", true))
    .take(5000);
  const first = await ctx.db.query("snapshots").order("asc").first();
  return {
    buildings: watched.length,
    records: src.currentCount ?? src.rowCount ?? 0,
    since: first ? new Date(first.capturedAt).toISOString().slice(0, 10) : "",
  };
}
