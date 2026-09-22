import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, query } from "./_generated/server";
import { paused } from "./guard";
import { earlierCitation } from "./schema";
import { CITY_FIELDS, citedBefore, cityQuery, fromCity, type CityRow, type Earlier } from "../engine/conditionHistory";

// A repair the city cited before under another number. The city's whole file
// for one building is read here, by the daily refresh of the sample's card and
// nothing else, and what the rule in engine/conditionHistory.ts finds in it is
// kept in repairHistory, one row per violation asked about. The page reads
// those rows and nothing else: nothing a visitor does can start a read of the
// city's file, and nothing public here does anything but read the small table.
//
// The city's rows live only as long as the refresh that read them: none is
// stored, and so neither are the city's apartment and story columns, which
// engine/adapters/nycHpd.ts does not keep either. A cache of the rows bought
// nothing, since the one daily read was always meant to miss it, and it came
// with a component's own daily cron.

/** Rows the city is asked for at a time. */
const PAGE = 2000;
/** And at most this many for one building, newest inspection first. */
const MAX_ROWS = 10_000;
/** Violations checked or looked up at once. A reply lists three. */
export const MAX_IDS = 10;
/** The one ingest/fetch.ts sends. */
const UA = "Faultline/0.1 (+https://clear-dogfish-72.convex.site; keeps dated copies of public filings)";

type Held = { read: number; rows: CityRow[] };

const isBbl = (s: string) => /^\d{10}$/.test(s);
const isViolation = (s: string) => /^\d{5,10}$/.test(s);

/**
 * The city's rows for one building, cut to the columns the rule reads, held by
 * the refresh that read them and no longer. A read that fails throws, and
 * nothing is kept from it.
 */
async function cityRows(bbl: string): Promise<Held> {
  const rows: CityRow[] = [];
  const seen = new Set<string>();
  let read = 0;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const url = cityQuery({
      $select: CITY_FIELDS.join(","),
      $where: `bbl='${bbl}'`,
      $order: "inspectiondate DESC,violationid",
      $limit: String(PAGE),
      $offset: String(offset),
    });
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from the city's housing file`);
    const page: unknown = JSON.parse(await res.text());
    if (!Array.isArray(page)) throw new Error("the city's housing file did not answer with rows");
    read += page.length;
    for (const raw of page) {
      const r = fromCity(raw);
      if (!r || seen.has(r.violationId)) continue;
      seen.add(r.violationId);
      rows.push(r);
    }
    if (page.length < PAGE) break;
  }
  // An empty answer is a failed read too. Only repairs the city's file lists at
  // this building are ever checked, so its file has rows; none back means the
  // city did not answer, not that nothing was ever cited there.
  if (read === 0) throw new Error(`the city's housing file answered with no rows for ${bbl}`);
  console.log(`[history] ${bbl}: read ${read} rows of the city's file`);
  return { read, rows };
}

/**
 * Check these violations at this building against the city's file, and keep
 * what was found. Internal only: run once after a deploy for the sample
 * building, and after that by the daily refresh of its asked repairs.
 */
export const refresh = internalAction({
  args: { bbl: v.string(), violationIds: v.array(v.string()) },
  returns: v.object({ read: v.number(), checked: v.number(), cited: v.array(v.string()) }),
  handler: async (ctx, { bbl, violationIds }): Promise<{ read: number; checked: number; cited: string[] }> => {
    if (!isBbl(bbl)) throw new Error(`not a parcel number: ${bbl}`);
    const ids = [...new Set(violationIds.filter(isViolation))].slice(0, MAX_IDS);
    if (ids.length === 0) return { read: 0, checked: 0, cited: [] };
    // A paused read is skipped, the same as ingest's: the file is read again next time.
    if (paused("ingest")) {
      console.log(`[history] ${bbl}: reads are paused, nothing checked`);
      return { read: 0, checked: 0, cited: [] };
    }
    const held = await cityRows(bbl);
    // A violation the rows do not hold gets an empty list, the same as one
    // with nothing before it: the page says nothing for either.
    const checked = ids.map((violationId) => ({ violationId, earlier: citedBefore(held.rows, violationId) }));
    await ctx.runMutation(internal.history.keep, { bbl, rowsRead: held.read, checked });
    return { read: held.read, checked: checked.length, cited: checked.filter((c) => c.earlier.length > 0).map((c) => c.violationId) };
  },
});

/**
 * One row per violation, replaced on every check, except by a check that read
 * none of the city's rows: that found nothing because it read nothing, and an
 * earlier citation already kept stays.
 */
export const keep = internalMutation({
  args: {
    bbl: v.string(),
    rowsRead: v.number(),
    checked: v.array(v.object({ violationId: v.string(), earlier: v.array(earlierCitation) })),
  },
  returns: v.null(),
  handler: async (ctx, { bbl, rowsRead, checked }) => {
    const checkedAt = Date.now();
    for (const { violationId, earlier } of checked.slice(0, MAX_IDS)) {
      const row = { violationId, bbl, earlier, checkedAt, rowsRead };
      const held = await ctx.db
        .query("repairHistory")
        .withIndex("by_violation", (q) => q.eq("violationId", violationId))
        .first();
      if (held && rowsRead === 0 && earlier.length === 0 && held.earlier.length > 0) continue;
      if (held) await ctx.db.replace(held._id, row);
      else await ctx.db.insert("repairHistory", row);
    }
    return null;
  },
});

/**
 * What was kept for the repairs on a page, at most ten of them: one indexed
 * read each, of this table only. A violation never checked is left out.
 */
export const forRepairs = query({
  args: { violationIds: v.array(v.string()) },
  returns: v.array(v.object({ violationId: v.string(), earlier: v.array(earlierCitation), checkedAt: v.number() })),
  handler: async (ctx, { violationIds }): Promise<{ violationId: string; earlier: Earlier[]; checkedAt: number }[]> => {
    const ids = [...new Set(violationIds.slice(0, 100).filter(isViolation))].slice(0, MAX_IDS);
    const out: { violationId: string; earlier: Earlier[]; checkedAt: number }[] = [];
    for (const violationId of ids) {
      const held = await ctx.db
        .query("repairHistory")
        .withIndex("by_violation", (q) => q.eq("violationId", violationId))
        .first();
      if (held) out.push({ violationId, earlier: held.earlier, checkedAt: held.checkedAt });
    }
    return out;
  },
});
