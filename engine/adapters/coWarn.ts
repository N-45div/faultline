import type { Fields, FetchBody, SourceAdapter } from "../types";
import { csvToObjects } from "../csv";
import { leadingInt, slug, usDate } from "../canon";
import { noticeSentence, warnNoticeGap } from "../rules";

type Raw = Record<string, string>;

// A bad sheet id or gid returns an HTML error page with a 200 or a 404. Any of
// these in the first 2 KB means the body is not the sheet.
const REJECT = ["<html", "<!doctype"];

const SHEET = "19jmo4Cwj933cmSBKV1t0zZ5O-2H5IpiLIhSH9MF8WF0";
const GID = "1928499704";

const tidy = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

const subjectKey = (r: Raw) => `${slug(tidy(r.Company))}|${slug(tidy(r["Workforce Area"]))}`;
const subjectLabel = (r: Raw) => `${tidy(r.Company)} — ${tidy(r["Workforce Area"])}`;

/** Colorado states a reason in free text; this is the only classification we make. */
function eventKind(reason: string): string {
  if (/closure|shutdown|closing/i.test(reason)) return "Closure";
  if (/layoff|rif|reduction/i.test(reason)) return "Layoff";
  return "";
}

/**
 * Colorado's WARN list, published as a Google Sheet the state edits in place.
 * It is hand-typed — two-digit years, trailing spaces in company names, a
 * totals block at the bottom — and it is the only one of our files that states
 * a reason in the employer's own words rather than a controlled vocabulary.
 *
 * Colorado has no state WARN act of its own, so the federal 60 days applies.
 * The sheet is scoped to one calendar year and the state publishes a new one
 * each January, so the id here is dated and must be rolled over.
 */
export const coWarn: SourceAdapter<Raw> = {
  id: "co-warn",
  version: 1,
  publisher: "Colorado Department of Labor and Employment",
  jurisdiction: "US-CO",
  datasetUrl: `https://docs.google.com/spreadsheets/d/${SHEET}/export?format=csv&gid=${GID}`,
  pageUrl: "https://cdle.colorado.gov/employers/layoff-separations/layoff-warn-list",
  transport: {
    kind: "http_text",
    url: `https://docs.google.com/spreadsheets/d/${SHEET}/export?format=csv&gid=${GID}`,
    format: "csv",
    rejectIfMatches: REJECT,
  },
  cadence: { baseMs: 4 * 60 * 60_000, hotMs: 2 * 60 * 60_000, jitterPct: 20, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    const head = body.text.slice(0, 2000).toLowerCase();
    if (REJECT.some((m) => head.includes(m))) return [];
    return csvToObjects(body.text).filter((r) => {
      const company = tidy(r.Company);
      // The sheet ends in a totals block: "Totals", "2026 YTD", "Total CO WARNs".
      if (!company || /^(totals?|total co warns|\d{4} ytd)$/i.test(company)) return false;
      return Boolean(usDate(r["WARN Date"]));
    });
  },
  // Composed from the normalised date, not the raw cell: the state hand-types
  // these and repairs typos in place, and a repaired date must read as an edit
  // to one notice rather than as a new one appearing and an old one vanishing.
  identity: (r) => `${subjectKey(r)}|${usDate(r["WARN Date"])}`,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  assertedAt: (r) => usDate(r["WARN Date"]),
  normalise(r): Fields {
    const reason = tidy(r["Reason for Layoffs"]);
    return {
      company: tidy(r.Company),
      noticeDate: usDate(r["WARN Date"]),
      effectiveDate: usDate(r["Begin Date"]),
      endDate: usDate(r["End Date"]) || null,
      // The sheet has no street address; the workforce area is the finest
      // location Colorado publishes.
      siteAddress: tidy(r["Workforce Area"]),
      county: tidy(r["Workforce Area"]),
      // Colorado counts twice: the nationwide action and the Colorado share.
      // Only the second is a Colorado layoff.
      employeesAffected: leadingInt(r["CO Notifications"]),
      totalNotified: leadingInt(r["Total Notified"]),
      permanent: leadingInt(r["# Permanent"]),
      temporary: leadingInt(r["#Temp"]),
      furloughs: leadingInt(r["#Furloughs"]),
      reason,
      layoffOrClosure: eventKind(reason),
      occupations: tidy(r["Occupations Impacted"]),
      naics: tidy(r.NAICS),
      receivedDate: usDate(r.Received) || null,
      // Colorado publishes no date for when a notice went online.
      postedDate: null,
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  significant: ["noticeDate", "effectiveDate", "employeesAffected", "reason"],
  noise: [
    { op: "trimCase", path: "reason" },
    { op: "trimCase", path: "company" },
    { op: "trimCase", path: "siteAddress" },
    { op: "trimCase", path: "occupations" },
  ],
  // Whole sheet, so absence is provable; the floor guards the January reset.
  presence: "open_world",
  render(after) {
    const r = warnNoticeGap({
      jurisdiction: "US-CO",
      noticeDate: String(after.noticeDate),
      effectiveDate: String(after.effectiveDate),
    });
    const base = noticeSentence(String(after.company), Number(after.employeesAffected) || 0, String(after.siteAddress), r, "Colorado");
    // Colorado is the only file that says why, in its own words.
    return after.reason ? `${base} Colorado's file gives the reason as "${String(after.reason)}".` : base;
  },
  // The sheet starts each January at a row or two and grows all year. A floor
  // this low still trips in early January — which is the right answer: a year
  // rollover is not two hundred employers withdrawing their notices.
  health: { minRows: 10, expectedKeys: ["Company", "WARN Date", "Begin Date", "CO Notifications", "Reason for Layoffs"] },
  budget: { credits: 0, maxFetchesPerDay: 12 },
};
