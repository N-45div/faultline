import type { Fields, FetchBody, SourceAdapter } from "../types";
import { tableByHeaders } from "../html";
import { firstUsDate, leadingInt, secondUsDate, slug, usDate } from "../canon";

import { noticeSentence, warnNoticeGap } from "../rules";

type Raw = Record<string, string>;

const HEADERS = ["Notice Date", "NAICS Code", "Company", "Location", "Local Area", "Total Employees", "Effective Date", "Type"];

// Two employers filed on the same day for the same site in 2026 and differ only
// by industry code, so the code is part of the identity.
const subjectKey = (r: Raw) => `${slug(r.Company)}|${slug(r.Location)}`;
const subjectLabel = (r: Raw) => `${r.Company} — ${r.Location}`;

/** "Mass Layoff- No Recall" and "Mass Layoff - No Recall" are the same event. */
function tidyType(s: string): string {
  return (s ?? "").replace(/\s*-\s*/g, " - ").replace(/\s+/g, " ").trim();
}

/** The file says "Anne Arundel County" and "Anne Arundel" in the same year. */
function tidyArea(s: string): string {
  return (s ?? "").replace(/\s+county\b/i, "").replace(/\s+/g, " ").trim();
}

/**
 * Maryland's WARN / ESA / other-dislocations log. It is an HTML table, one
 * calendar year at a time, with no ETag and no publication date — the page
 * simply changes. Maryland's Economic Stabilization Act sets the same 60 days
 * as federal WARN but bites at a lower threshold, so this log carries small
 * layoffs that never appear in a federal-threshold file.
 *
 * The log is deliberately broader than the statute: the state also lists
 * dislocations that meet no threshold at all. A row here is therefore evidence
 * that a notice was filed, never evidence that one was required.
 */
export const mdWarn: SourceAdapter<Raw> = {
  id: "md-warn",
  version: 1,
  publisher: "Maryland Department of Labor",
  jurisdiction: "US-MD",
  datasetUrl: "https://labor.maryland.gov/employment/warn.shtml",
  pageUrl: "https://labor.maryland.gov/employment/warn.shtml",
  transport: {
    kind: "http_text",
    url: "https://labor.maryland.gov/employment/warn.shtml",
    format: "html",
    rejectIfMatches: [],
  },
  cadence: { baseMs: 6 * 60 * 60_000, hotMs: 3 * 60 * 60_000, jitterPct: 20, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    // Chosen by its header row, not its position: the page carries a second,
    // currently empty, federal RIF log that may fill at any time.
    return tableByHeaders(body.text, HEADERS).filter((r) => r.Company && r["Notice Date"]);
  },
  identity: (r) => `${subjectKey(r)}|${usDate(r["Notice Date"])}|${slug(r["NAICS Code"])}`,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  assertedAt: (r) => usDate(r["Notice Date"]),
  normalise(r): Fields {
    const end = secondUsDate(r["Effective Date"]);
    return {
      company: r.Company,
      noticeDate: usDate(r["Notice Date"]),
      // Ranges are common and sometimes malformed. The first date is the one
      // the 60 days is measured against; the rest is kept, never parsed.
      effectiveDate: firstUsDate(r["Effective Date"]),
      effectiveDateEnd: end || null,
      effectiveDateRaw: r["Effective Date"],
      siteAddress: r.Location,
      county: tidyArea(r["Local Area"]),
      employeesAffected: leadingInt(r["Total Employees"]),
      workersRaw: r["Total Employees"],
      naics: r["NAICS Code"],
      layoffOrClosure: tidyType(r.Type),
      // Maryland publishes no date of its own for when a notice went online.
      postedDate: null,
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  significant: ["noticeDate", "effectiveDate", "employeesAffected", "layoffOrClosure"],
  noise: [
    { op: "trimCase", path: "layoffOrClosure" },
    { op: "trimCase", path: "county" },
    { op: "trimCase", path: "siteAddress" },
    { op: "trimCase", path: "company" },
  ],
  presence: "closed_world",
  render(after) {
    const r = warnNoticeGap({
      jurisdiction: "US-MD",
      noticeDate: String(after.noticeDate),
      effectiveDate: String(after.effectiveDate),
    });
    return noticeSentence(String(after.company), Number(after.employeesAffected) || 0, String(after.siteAddress), r, "Maryland");
  },
  // The page holds one calendar year, so in early January the true count is a
  // handful of rows. The header row is the integrity guard here, not a floor.
  health: { minRows: 0, expectedKeys: ["Company", "Notice Date", "Effective Date", "Total Employees"] },
  budget: { credits: 0, maxFetchesPerDay: 8 },
};
