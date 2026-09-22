import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { paused } from "./guard";
import { limits } from "./limits";
import { cityPageOutcome } from "./schema";
import { isViolationId } from "../engine/hpdOnline";

// HPD Online's own page for a repair, read the moment someone answers about
// it. The answer is recorded first (convex/inbound.ts answerReceipt), and that
// schedules request here; request decides whether a browser is needed at all,
// and capture (convex/cityPageCapture.ts) opens the page through Firecrawl,
// searches it for the number and keeps what it shows. The page is quoted beside
// the data file's row, and neither is said to be the other.
//
// A visitor controls no part of the reading: the host is fixed, the building
// id comes from the city's data file, and the number from the answer kept.

/** A page read, or found not to list the repair, stands this long: everyone who answers about it inside that time is shown it again. */
const STANDS_MS = 6 * 60 * 60_000;
/** A reading still going, or one that failed, holds off another for this long. */
const HOLD_MS = 10 * 60_000;
/** Repairs one page may ask about at once. */
export const MAX_IDS = 5;

/** Whether this reading is still worth showing instead of reading again. */
function stands(row: Doc<"cityPages">, now: number): boolean {
  const age = now - row.capturedAt;
  if (row.outcome === "kept" || row.outcome === "not_found") return age < STANDS_MS;
  if (row.outcome === "capped") return false;
  return age < HOLD_MS;
}

/** The newest reading of one repair: one indexed read. */
const newest = (ctx: { db: QueryCtx["db"] }, violationId: string): Promise<Doc<"cityPages"> | null> =>
  ctx.db
    .query("cityPages")
    .withIndex("by_violation", (q) => q.eq("violationId", violationId))
    .order("desc")
    .first();

/**
 * Someone answered about this repair. Read HPD Online's page for it, unless it
 * was read in the last six hours, in which case that reading is the one shown
 * and nothing is spent. `from` is who answered, an address or a browser's
 * identity; it keys their own daily room and is not written anywhere else.
 */
export const request = internalMutation({
  args: { violationId: v.string(), from: v.string() },
  returns: v.null(),
  handler: async (ctx, { violationId, from }) => {
    if (!isViolationId(violationId)) return null;
    // No key, no reading: a deployment without Firecrawl writes nothing here.
    if (!process.env.FIRECRAWL_API_KEY || paused("ingest")) return null;
    const now = Date.now();
    const last = await newest(ctx, violationId);
    if (last && stands(last, now)) return null;
    const mine = await limits.limit(ctx, "cityPageSession", { key: from });
    const all = mine.ok ? await limits.limit(ctx, "cityPageAll") : mine;
    if (!mine.ok || !all.ok) {
      await ctx.db.insert("cityPages", {
        violationId,
        buildingId: "",
        capturedAt: now,
        sha256: "",
        outcome: "capped",
        why: mine.ok ? "HPD Online has been read as many times today as we read it in a day" : "that is as many readings of HPD Online as one person starts in a day",
      });
      return null;
    }
    const pageId = await ctx.db.insert("cityPages", { violationId, buildingId: "", capturedAt: now, sha256: "", outcome: "reading" });
    await ctx.scheduler.runAfter(0, internal.cityPageCapture.capture, { pageId, violationId, attempt: 1 });
    return null;
  },
});

/**
 * How a reading ended, written as it happened: the page kept, with its status
 * if one could be read, or why nothing was. A page kept is compared with the
 * last page kept for the same repair, and a different hash says since when.
 */
export const finish = internalMutation({
  args: {
    pageId: v.id("cityPages"),
    outcome: cityPageOutcome,
    buildingId: v.optional(v.string()),
    sha256: v.optional(v.string()),
    markdownId: v.optional(v.id("_storage")),
    screenshotId: v.optional(v.id("_storage")),
    statusText: v.optional(v.string()),
    statusDate: v.optional(v.string()),
    certDate: v.optional(v.string()),
    why: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { pageId, outcome, ...got }) => {
    const row = await ctx.db.get(pageId);
    if (!row) return null;
    let changedFrom: number | undefined;
    if (got.sha256 && (outcome === "kept" || outcome === "not_found")) {
      // The last reading of this repair that ended in a page, this one aside.
      // Failed and busy readings between them are skipped; a handful at most.
      const earlier = await ctx.db
        .query("cityPages")
        .withIndex("by_violation", (q) => q.eq("violationId", row.violationId))
        .order("desc")
        .take(12);
      const before = earlier.find((r) => r._id !== pageId && r.sha256 !== "" && (r.outcome === "kept" || r.outcome === "not_found"));
      if (before && before.sha256 !== got.sha256) changedFrom = before.capturedAt;
    }
    await ctx.db.patch(pageId, {
      outcome,
      capturedAt: Date.now(),
      ...got,
      ...(changedFrom !== undefined ? { changedFrom } : {}),
    });
    return null;
  },
});

const shownRow = v.object({
  violationId: v.string(),
  buildingId: v.string(),
  outcome: cityPageOutcome,
  capturedAt: v.number(),
  sha256: v.string(),
  statusText: v.optional(v.string()),
  statusDate: v.optional(v.string()),
  certDate: v.optional(v.string()),
  why: v.optional(v.string()),
  changedFrom: v.optional(v.number()),
  screenshotUrl: v.union(v.string(), v.null()),
  markdownUrl: v.union(v.string(), v.null()),
});

/**
 * The newest reading of HPD Online for each repair on a page, at most five:
 * one indexed read each, of this table only. A repair never read is left out.
 */
export const forViolations = query({
  args: { violationIds: v.array(v.string()) },
  returns: v.array(shownRow),
  handler: async (ctx, { violationIds }) => {
    const ids = [...new Set(violationIds.slice(0, 50).filter(isViolationId))].slice(0, MAX_IDS);
    const out = [];
    for (const violationId of ids) {
      const r = await newest(ctx, violationId);
      if (!r) continue;
      out.push({
        violationId,
        buildingId: r.buildingId,
        outcome: r.outcome,
        capturedAt: r.capturedAt,
        sha256: r.sha256,
        ...(r.statusText !== undefined ? { statusText: r.statusText } : {}),
        ...(r.statusDate !== undefined ? { statusDate: r.statusDate } : {}),
        ...(r.certDate !== undefined ? { certDate: r.certDate } : {}),
        ...(r.why !== undefined ? { why: r.why } : {}),
        ...(r.changedFrom !== undefined ? { changedFrom: r.changedFrom } : {}),
        screenshotUrl: r.screenshotId ? await ctx.storage.getUrl(r.screenshotId) : null,
        markdownUrl: r.markdownId ? await ctx.storage.getUrl(r.markdownId) : null,
      });
    }
    return out;
  },
});
