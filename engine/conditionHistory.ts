import { OWNER_SAYS_FIXED } from "./hpd";

// The same condition, cited before under another number. HPD gives every
// citation a number of its own, so when an inspector writes up a condition the
// owner already certified corrected, or the city already closed, nothing in
// the new row says so. This finds the earlier row by the city's own words and
// nothing looser: the same description, word for word, at the same apartment
// and story, inspected on an earlier day, and certified or closed before the
// later inspection. A description one word apart is a different citation here.
//
// Pure: rows in, links out. convex/history.ts reads the city's rows and keeps
// what this finds; the page only reads what was kept.

/** The city's file for housing violations, the one engine/adapters/nycHpd.ts reads. */
const CITY_FILE = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json";

/** The columns the rule reads, and no others. */
export const CITY_FIELDS = [
  "violationid",
  "apartment",
  "story",
  "inspectiondate",
  "novdescription",
  "currentstatus",
  "currentstatusdate",
  "violationstatus",
  "certifieddate",
] as const;

/** One of the city's rows, cut to what the rule reads. Days are YYYY-MM-DD. */
export type CityRow = {
  violationId: string;
  /** Empty for a common area. */
  apartment: string;
  story: string;
  inspected: string | null;
  /** The city's description, as written. */
  text: string;
  status: string;
  statusDate: string | null;
  /** The city's own open-or-closed column says Close. */
  closed: boolean;
  certified: string | null;
};

/** An earlier citation of the same condition, in the city's own fields. */
export type Earlier = {
  violationId: string;
  inspectionDate: string;
  certifiedDate: string | null;
  status: string;
  statusDate: string | null;
};

/** More than this, and the page would only ever show the newest anyway. */
export const MAX_EARLIER = 5;

const day = (s: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s ?? "").trim());
  return m ? m[1] : null;
};

/** A row as the city's API serves it, cut to what the rule reads. Null without a violation number. */
export function fromCity(raw: unknown): CityRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const violationId = String(r.violationid ?? "").trim();
  if (!/^\d{1,12}$/.test(violationId)) return null;
  return {
    violationId,
    apartment: String(r.apartment ?? "").trim().toUpperCase(),
    story: String(r.story ?? "").trim().toUpperCase(),
    inspected: day(r.inspectiondate),
    text: String(r.novdescription ?? ""),
    status: String(r.currentstatus ?? "").trim(),
    statusDate: day(r.currentstatusdate),
    closed: String(r.violationstatus ?? "").trim().toUpperCase() === "CLOSE",
    certified: day(r.certifieddate),
  };
}

/**
 * The description as the rule compares it: upper case, runs of whitespace as
 * one space. Some of the city's rows carry the section sign as U+FFFD, the
 * replacement character, where others carry §; the two are read as the same.
 */
export function sameText(text: string): string {
  return (text ?? "").replace(/�/g, "§").toUpperCase().replace(/\s+/g, " ").trim();
}

// Words that put a condition somewhere. A description with none of them could
// be anywhere in the building, so the same words twice say nothing about one
// place.
const PLACE = /\b(?:APT|APARTMENT|STORY|ROOM|KITCHEN|BATHROOM|BEDROOM|HALL|HALLWAY|STAIRS?|CELLAR|BASEMENT|ROOF|LOBBY|CLOSET|FOYER|LIVING|DINING|PUBLIC|ENTRANCE|COURT|YARD|BOILER|COMPACTOR|FLOOR|SECTION|WINDOW|DOOR)\b/;

// Orders to put up a sign or a notice, or to file or hand over papers. The city
// words them the same way at every building every year, so the same words
// twice are the same form, not the same condition.
const NOTICE = [
  /\bPOST(?:,| (?:AND MAINTAIN )?(?:A )?(?:PROPER )?(?:SIGN|NOTICE|STREET NUMBER)\b)/,
  /\bFILE (?:ANNUAL|A |WITH )/,
  /\bCORRECT FAILURE TO (?:PROVIDE|NOTIFY|FILE)\b/,
  /\bREGISTRATION\b/,
  /HOUSING INFORMATION GUIDE/,
  /\bSUBMIT\b/,
  /\bCERTIFICATION OF\b/,
];

// A common area named by the section of the building it is in: SECTION ''730''
// or BUILDING SECTION 160. A complex of several buildings under one parcel
// number has a public hall on the sixth story in each of them.
const SECTION = /\bSECTION ''\s*[A-Z0-9][^']*''|\bBUILDING SECTION \d+/;

export type NotLinked = "no description" | "a sign or notice" | "no location words" | "a common area not pinned to one section";

/** Why a row can never be linked to another, or null when it can. */
export function whyNot(row: CityRow): NotLinked | null {
  const t = sameText(row.text);
  if (!t) return "no description";
  if (NOTICE.some((re) => re.test(t))) return "a sign or notice";
  if (!PLACE.test(t)) return "no location words";
  if (!row.apartment && !SECTION.test(t)) return "a common area not pinned to one section";
  return null;
}

/** Certified corrected, or closed by the city, before the given day, by the row's own dates. */
export function resolvedBefore(row: CityRow, when: string): boolean {
  if (row.certified && row.certified < when) return true;
  return row.closed && row.statusDate !== null && row.statusDate < when;
}

/**
 * The earlier citations of the same condition as one violation, newest first:
 * the same words, the same apartment and story, a different number, an earlier
 * inspection day, certified or closed before the later inspection. Two rows
 * written up on the same day are one visit's duplicates, never a history.
 */
export function citedBefore(rows: CityRow[], violationId: string, max = MAX_EARLIER): Earlier[] {
  const later = rows.find((r) => r.violationId === violationId);
  if (!later || !later.inspected || whyNot(later)) return [];
  const when = later.inspected;
  const text = sameText(later.text);
  return rows
    .filter(
      (a) =>
        a.violationId !== later.violationId &&
        a.inspected !== null &&
        a.inspected < when &&
        a.apartment === later.apartment &&
        a.story === later.story &&
        sameText(a.text) === text &&
        resolvedBefore(a, when),
    )
    .sort((x, y) => (x.inspected! < y.inspected! ? 1 : x.inspected! > y.inspected! ? -1 : y.violationId.localeCompare(x.violationId)))
    .slice(0, max)
    .map((a) => ({ violationId: a.violationId, inspectionDate: a.inspected!, certifiedDate: a.certified, status: a.status, statusDate: a.statusDate }));
}

/**
 * Only the rows whose description another violation number shares: the only
 * rows a link can be made from. The rest of a building's file is most of it,
 * and is not kept.
 */
export function sharingText(rows: CityRow[]): CityRow[] {
  const ids = new Map<string, Set<string>>();
  for (const r of rows) {
    const t = sameText(r.text);
    if (!t) continue;
    ids.set(t, (ids.get(t) ?? new Set()).add(r.violationId));
  }
  return rows.filter((r) => (ids.get(sameText(r.text))?.size ?? 0) >= 2);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2025-07-31 as 31 Jul 2025. */
export function dayName(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : d;
}

/**
 * The line under a repair the city cited before: the earlier number, and what
 * the owner and the city each put on it, in the order they did, in the city's
 * own words. The owner's own certification stamp as the status says nothing
 * the certification date does not, so it is left out.
 */
export function citedBeforeLine(e: Earlier): string {
  const said: [string, string][] = [];
  if (e.certifiedDate) said.push([e.certifiedDate, `the owner certified it on ${dayName(e.certifiedDate)}`]);
  if (e.status && e.statusDate && !OWNER_SAYS_FIXED.has(e.status.toUpperCase())) said.push([e.statusDate, `the city recorded ${e.status} on ${dayName(e.statusDate)}`]);
  said.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return said.length > 0 ? `Cited before under #${e.violationId}: ${said.map((s) => s[1]).join("; ")}.` : `Cited before under #${e.violationId}.`;
}

/** Every character a query string could misread, percent-encoded, quotes and brackets included. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A query of the city's file, every parameter percent-encoded. */
export function cityQuery(params: Record<string, string>): string {
  return `${CITY_FILE}?${Object.entries(params)
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join("&")}`;
}

/** The city's own rows for these violation numbers, oldest inspection first, as its API serves them. */
export function cityRowsUrl(violationIds: string[]): string {
  const ids = violationIds.filter((id) => /^\d{5,10}$/.test(id));
  return cityQuery({
    $select: "violationid,inspectiondate,novdescription,certifieddate,currentstatus,currentstatusdate",
    $where: `violationid in(${ids.map((id) => `'${id}'`).join(",")})`,
    $order: "inspectiondate",
  });
}
