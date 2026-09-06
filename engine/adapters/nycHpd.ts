import type { Fields, FetchBody, SourceAdapter } from "../types";
import { dateOnly } from "../canon";

const DOMAIN = "data.cityofnewyork.us";
const RESOURCE = "wvxf-dwi5";
const STAMPS = "('FALSE CERTIFICATION','INVALID CERTIFICATION')";

type Raw = Record<string, string | undefined>;

const q = (s: string) => s.replace(/'/g, "''");

function label(r: Raw): string {
  return `${r.housenumber ?? ""} ${r.streetname ?? ""}, ${titleCase(r.boro ?? "")}`.replace(/\s+/g, " ").trim();
}

/**
 * NYC HPD housing maintenance code violations. The city's own status
 * vocabulary contains FALSE CERTIFICATION; currentstatus is overwritten in
 * place, so this table is the only history of it anywhere.
 */
export const nycHpd: SourceAdapter<Raw> = {
  id: "nyc-hpd",
  version: 1,
  publisher: "NYC Department of Housing Preservation and Development",
  jurisdiction: "US-NY-NYC",
  datasetUrl: `https://${DOMAIN}/resource/${RESOURCE}.json`,
  pageUrl: `https://${DOMAIN}/Housing-Development/Housing-Maintenance-Code-Violations/${RESOURCE}`,
  transport: {
    kind: "socrata",
    domain: DOMAIN,
    resourceId: RESOURCE,
    maxKeysPerQuery: 100,
    // ~50 bytes back. Is anything happening? Counted, never stored.
    pulse: (cursor) =>
      `$select=count(1)&$where=currentstatus in${STAMPS} AND currentstatusdate>='${dateOnly(cursor)}'`,
    // Only the buildings somebody is looking at. Rows backfill, so the cursor
    // trails by days and identity+sigHash dedupe does the rest.
    watch: (bbls, cursor) =>
      `$limit=5000&$order=currentstatusdate DESC` +
      `&$where=bbl in(${bbls.map((b) => `'${q(b)}'`).join(",")}) AND currentstatusdate>='${dateOnly(cursor)}'`,
  },
  // Hourly. At fifteen minutes this file alone read ~1,800 rows 96 times a
  // day — a quarter of a gigabyte of database bandwidth daily, and the
  // reason the deployment was switched off on 4 September. A stamp is not
  // undone by being noticed forty minutes later.
  cadence: { baseMs: 60 * 60_000, hotMs: 30 * 60_000, jitterPct: 15, gate: "always" },
  targeting: "server_filter",
  subjectKind: "building",
  claimKind: "hpd.violation_status",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    const rows = JSON.parse(body.text);
    return Array.isArray(rows) ? rows : [];
  },
  identity: (r) => `${r.bbl}/${r.violationid}`,
  subjectOf: (r) => ({ kind: "building", key: String(r.bbl), label: label(r) }),
  assertedAt: (r) => dateOnly(r.currentstatusdate ?? ""),
  normalise(r): Fields {
    return {
      violationid: r.violationid ?? "",
      bbl: r.bbl ?? "",
      boro: r.boro ?? "",
      housenumber: r.housenumber ?? "",
      streetname: r.streetname ?? "",
      class: r.class ?? "",
      currentstatus: r.currentstatus ?? "",
      currentstatusdate: dateOnly(r.currentstatusdate ?? ""),
      certifiedbydate: r.certifiedbydate ? dateOnly(r.certifiedbydate) : null,
      inspectiondate: r.inspectiondate ? dateOnly(r.inspectiondate) : null,
      violationstatus: r.violationstatus ?? "",
      novdescription: (r.novdescription ?? "").replace(/\s+/g, " ").trim().slice(0, 512),
      // The unit number is redacted on every shared surface. It lives only on
      // the private case page, so it is never part of the public row.
      __subjectKind: "building",
      __subjectKey: r.bbl ?? "",
      __subjectLabel: label(r),
    };
  },
  significant: ["currentstatus", "currentstatusdate", "certifiedbydate"],
  noise: [
    { op: "dateOnly", path: "currentstatusdate" },
    { op: "dateOnly", path: "certifiedbydate" },
  ],
  presence: "closed_world",
  render(after, before) {
    const where = String(after.__subjectLabel);
    const status = String(after.currentstatus);
    const on = String(after.currentstatusdate);
    const cls = after.class ? ` (class ${after.class})` : "";
    if (status === "FALSE CERTIFICATION" || status === "INVALID CERTIFICATION") {
      const certified = after.certifiedbydate
        ? ` The owner had certified it corrected by ${after.certifiedbydate}.`
        : "";
      return `HPD stamped a violation at ${where} ${status} on ${on}${cls}.${certified}`;
    }
    if (before) return `A violation at ${where}${cls} moved from ${before.currentstatus} to ${status} on ${on}.`;
    return `A violation at ${where}${cls} is ${status} as of ${on}.`;
  },
  health: { minRows: 0, expectedKeys: ["violationid", "bbl", "currentstatus", "currentstatusdate"] },
  budget: { credits: 0, maxFetchesPerDay: 300 },
};

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
