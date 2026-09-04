import type { Fields, FetchBody, SourceAdapter } from "../types";
import { dateOnly } from "../canon";

const DOMAIN = "data.cityofnewyork.us";
const RESOURCE = "43nn-pn8j";

type Raw = Record<string, string | undefined>;

const q = (s: string) => s.replace(/'/g, "''");
const tidy = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function label(r: Raw): string {
  const where = `${tidy(r.building)} ${tidy(r.street)}, ${titleCase(tidy(r.boro))}`.replace(/\s+/g, " ").trim();
  return where.replace(/^,\s*/, "");
}

/**
 * NYC restaurant inspections, and the clearest case in this whole product for
 * why versions are the product.
 *
 * The Health Department's own description of this file says it: it holds
 * violations "conducted up to three years prior to the most recent
 * inspection", for establishments "in an active status on the RECORD DATE",
 * and "only restaurants in an active status are included in the dataset". So
 * a restaurant that closes does not merely stop being updated — its whole
 * inspection history leaves the file, and the city's own site can no longer
 * show what it was cited for. Thousands open and close every year, in the
 * department's own words.
 *
 * Everything is keyed on the same 10-digit BBL that HPD uses, so what we hold
 * lands on the building's page beside its housing record.
 *
 * The file also carries a phone number for each establishment. It is read and
 * dropped: it is no part of what a person needs from an inspection record,
 * and a number we never store cannot leak.
 */
export const nycRestaurants: SourceAdapter<Raw> = {
  id: "nyc-restaurants",
  version: 1,
  publisher: "NYC Department of Health and Mental Hygiene",
  jurisdiction: "US-NY-NYC",
  datasetUrl: `https://${DOMAIN}/resource/${RESOURCE}.json`,
  pageUrl: `https://${DOMAIN}/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/${RESOURCE}`,
  transport: {
    kind: "socrata",
    domain: DOMAIN,
    resourceId: RESOURCE,
    // Smaller pages than the housing file: each building brings its whole
    // history back, not one day of it.
    maxKeysPerQuery: 40,
    // Cheap and countable: has the city closed anything since the cursor?
    pulse: (cursor) => `$select=count(1)&$where=action like '%25Closed by DOHMH%25' AND inspection_date>='${dateOnly(cursor)}'`,
    // Deliberately unfiltered by date, unlike the housing file. A building's
    // inspection history is the thing that disappears when a restaurant
    // closes, so what is worth holding is the whole current slice for the
    // buildings we watch — not the last three days of it. The cursor is
    // ignored; identity plus sigHash mean re-reading the same rows writes
    // nothing.
    watch: (bbls) => `$limit=5000&$order=inspection_date DESC&$where=bbl in(${bbls.map((b) => `'${q(b)}'`).join(",")})`,
  },
  cadence: { baseMs: 60 * 60_000, hotMs: 30 * 60_000, jitterPct: 15, gate: "always" },
  targeting: "server_filter",
  subjectKind: "building",
  claimKind: "dohmh.inspection",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    const rows = JSON.parse(body.text);
    // A row without a BBL cannot be filed under a building, and this file is
    // read by building. Four rows in eight hundred.
    return Array.isArray(rows) ? rows.filter((r: Raw) => tidy(r.bbl)) : [];
  },
  // One citation, at one inspection, at one establishment. An inspection with
  // no violations carries no violation code, so the action stands in for it.
  identity: (r) => `${tidy(r.bbl)}/${tidy(r.camis)}/${dateOnly(r.inspection_date ?? "")}/${tidy(r.violation_code) || "none"}`,
  subjectOf: (r) => ({ kind: "building", key: tidy(r.bbl), label: label(r) }),
  assertedAt: (r) => dateOnly(r.inspection_date ?? ""),
  normalise(r): Fields {
    return {
      camis: tidy(r.camis),
      bbl: tidy(r.bbl),
      // The trading name — what is on the door, and what a person searches.
      dba: tidy(r.dba),
      building: tidy(r.building),
      street: tidy(r.street),
      boro: titleCase(tidy(r.boro)),
      zipcode: tidy(r.zipcode),
      cuisine: tidy(r.cuisine_description),
      inspectionDate: dateOnly(r.inspection_date ?? ""),
      inspectionType: tidy(r.inspection_type),
      // The city's own words for what it did and what it found.
      action: tidy(r.action),
      violationCode: tidy(r.violation_code),
      violationDescription: tidy(r.violation_description).slice(0, 512),
      criticalFlag: tidy(r.critical_flag),
      grade: tidy(r.grade) || null,
      gradeDate: r.grade_date ? dateOnly(r.grade_date) : null,
      score: r.score !== undefined && r.score !== "" ? Number(r.score) : null,
      // The date of the data pull the row came from — the city's own marker
      // for "this file is a snapshot", and the reason history leaves it.
      recordDate: r.record_date ? dateOnly(r.record_date) : null,
      __subjectKind: "building",
      __subjectKey: tidy(r.bbl),
      __subjectLabel: label(r),
    };
  },
  // What the city did, what grade it left, and how bad it judged it. The
  // record date moves on every pull and would otherwise make every row look
  // changed every cycle.
  significant: ["action", "grade", "score", "criticalFlag", "violationDescription"],
  noise: [
    { op: "drop", path: "recordDate" },
    { op: "dateOnly", path: "gradeDate" },
    { op: "trimCase", path: "dba" },
    { op: "trimCase", path: "action" },
    { op: "trimCase", path: "violationDescription" },
  ],
  // A server-filtered slice: absence here is not proof of anything, so a row
  // that stops coming back is never reported as removed.
  presence: "closed_world",
  render(after, before) {
    const name = String(after.dba || "A restaurant");
    const where = String(after.__subjectLabel);
    const on = String(after.inspectionDate);
    const action = String(after.action ?? "");
    if (/closed by dohmh/i.test(action)) {
      const reopened = /re-opened/i.test(action);
      return reopened
        ? `New York City re-opened ${name} at ${where} on ${on}.`
        : `New York City closed ${name} at ${where} on ${on}. The city's words: "${action}"`;
    }
    if (before && before.grade !== after.grade && after.grade) {
      return `${name} at ${where} went from grade ${String(before.grade ?? "none")} to ${String(after.grade)} on ${on}.`;
    }
    const cited = after.violationDescription ? ` The citation reads: "${String(after.violationDescription)}"` : "";
    const critical = String(after.criticalFlag) === "Critical" ? " The city marks it critical." : "";
    return `${name} at ${where} was inspected on ${on}.${critical}${cited}`;
  },
  health: { minRows: 0, expectedKeys: ["camis", "bbl", "inspection_date", "action"] },
  budget: { credits: 0, maxFetchesPerDay: 120 },
};

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
