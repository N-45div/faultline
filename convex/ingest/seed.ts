import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { addressTokens } from "../../engine/match";

const HEADERS = { "User-Agent": "Notice/0.1", Accept: "application/json" };
const HPD = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json";

/**
 * The standing cohort: the NYC buildings with the most open violations, so the
 * wall has real before→after rows for buildings nobody has asked about yet.
 * About 2% of open violations, bounded, and labelled as what it is.
 */
export const standingHpdCohort = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ fetched: v.number(), added: v.number() }),
  handler: async (ctx, { limit }) => {
    const n = Math.min(limit ?? 300, 1000);
    const url = encodeURI(`${HPD}?$select=bbl,count(1) as n&$where=violationstatus='Open'&$group=bbl&$order=n DESC&$limit=${n}`);
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Socrata`);
    const rows: { bbl: string; n: string }[] = await res.json();
    const bbls = rows.map((r) => r.bbl).filter((b) => /^\d{10}$/.test(b));
    const added: number = await ctx.runMutation(internal.ingest.write.addTargets, {
      slug: "nyc-hpd",
      subjectKeys: bbls,
      addedBy: "standing",
    });
    return { fetched: bbls.length, added };
  },
});

const BOROS: [RegExp, string][] = [
  [/\bbronx\b/i, "BRONX"],
  [/\bbrooklyn\b/i, "BROOKLYN"],
  [/\bmanhattan\b/i, "MANHATTAN"],
  [/\bqueens\b/i, "QUEENS"],
  [/\bstaten\b/i, "STATEN ISLAND"],
];

/**
 * Someone asked about a building we don't hold. Find its BBL from the city's
 * own address fields, start following it, and pull it on the next tick.
 */
export const resolveAddress = internalAction({
  args: { q: v.string(), inboxId: v.optional(v.id("inbox")) },
  returns: v.object({ bbls: v.array(v.string()) }),
  handler: async (ctx, { q, inboxId }) => {
    const tokens = addressTokens(q);
    if (tokens.length < 2) return { bbls: [] };
    const house = tokens[0].toUpperCase().replace(/'/g, "''");
    const street = tokens.slice(1).join(" ").toUpperCase().replace(/'/g, "''");
    const boro = BOROS.find(([re]) => re.test(q))?.[1];
    let where = `housenumber='${house}' AND starts_with(streetname,'${street}')`;
    if (boro) where += ` AND boro='${boro}'`;
    const url = encodeURI(`${HPD}?$select=bbl&$where=${where}&$limit=25`);
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Socrata`);
    const rows: { bbl: string }[] = await res.json();
    const bbls = [...new Set(rows.map((r) => r.bbl).filter((b) => /^\d{10}$/.test(b)))];
    if (bbls.length === 0) return { bbls };

    await ctx.runMutation(internal.ingest.write.addTargets, { slug: "nyc-hpd", subjectKeys: bbls, addedBy: "case" });
    if (inboxId) await ctx.runMutation(internal.ingest.write.markInboxSubject, { inboxId, subjectKey: bbls[0] });
    await ctx.runMutation(internal.sources.runNow, { slug: "nyc-hpd" });
    return { bbls };
  },
});
