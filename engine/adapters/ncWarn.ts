import type { Fields, FetchBody, SourceAdapter } from "../types";
import { csvToObjects } from "../csv";
import { leadingInt, slug, usDate } from "../canon";
import { noticeSentence, warnNoticeGap } from "../rules";

type Raw = Record<string, string>;

// A rotated-away S3 key answers 403 with an XML error body, not HTML, so the
// usual "did we get a web page instead of a file" guard is not enough here.
const REJECT = ["<?xml", "accessdenied", "<html", "<!doctype"];

const YEAR_PAGE =
  "https://www.commerce.nc.gov/data-tools-reports/labor-market-data-tools/workforce-warn-reports/report-workforce-warn-summary-list-2026";

const tidy = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

const site = (r: Raw) => tidy([r["Address 1"], r.City].filter(Boolean).join(", "));
const subjectKey = (r: Raw) => `${slug(tidy(r["WARN Notice: WARN Notice Name"]))}|${slug(site(r))}`;
const subjectLabel = (r: Raw) => `${tidy(r["WARN Notice: WARN Notice Name"])} — ${site(r)}`;

/**
 * North Carolina renames its file every time it publishes it — the path
 * carries the publish date, and yesterday's path answers 403. One page links
 * to the current one, so we read that page first and take the link from it.
 */
function findCsvLink(html: string): string | null {
  const m = /href="(https:\/\/files\.nc\.gov\/[^"]*warn[^"]*\.csv[^"]*)"/i.exec(html);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

/**
 * North Carolina's WARN summary list. Best-instrumented of our sources: the
 * file itself answers with a real ETag and Last-Modified, and the state issues
 * each notice a number. The number is not unique on its own — one notice can
 * cover six sites — so the site is part of the identity.
 *
 * North Carolina has no state WARN act of its own; the federal 60 days applies.
 */
export const ncWarn: SourceAdapter<Raw> = {
  id: "nc-warn",
  version: 1,
  publisher: "North Carolina Department of Commerce",
  jurisdiction: "US-NC",
  datasetUrl: YEAR_PAGE,
  pageUrl: YEAR_PAGE,
  transport: {
    kind: "http_text",
    // The last path we knew, used only if the year page cannot be read.
    url: "https://files.nc.gov/commerce/2026-08/warn%20summary%20report%20081526.csv",
    format: "csv",
    rejectIfMatches: REJECT,
    discover: { pageUrl: YEAR_PAGE, find: findCsvLink },
  },
  cadence: { baseMs: 6 * 60 * 60_000, hotMs: 3 * 60 * 60_000, jitterPct: 20, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    const head = body.text.slice(0, 2000).toLowerCase();
    if (REJECT.some((m) => head.includes(m))) return [];
    return csvToObjects(body.text).filter((r) => r["WARN Notice: WARN Notice Name"] && usDate(r["Date of Notice"]));
  },
  // The state's own number, plus the site: notice 202600028 covers six of them.
  identity: (r) => `${tidy(r["Warn Number"])}|${slug(site(r))}`,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  assertedAt: (r) => usDate(r["Date of Notice"]),
  normalise(r): Fields {
    const county = tidy(r.County);
    return {
      company: tidy(r["WARN Notice: WARN Notice Name"]),
      noticeDate: usDate(r["Date of Notice"]),
      effectiveDate: usDate(r["Effective Date"]),
      siteAddress: site(r),
      // Out-of-state headquarters filings carry the literal string "N/A".
      county: county === "N/A" ? "" : county,
      employeesAffected: leadingInt(r["Number affected at this location"]),
      warnNumber: tidy(r["Warn Number"]),
      // The two type columns are named the opposite way round to what you would
      // guess: "WARN notice type" holds Closure or Layoff, and "Type of layoff
      // or closure" holds Permanent or Temporary.
      layoffOrClosure: tidy(r["WARN notice type"]),
      permanentOrTemporary: tidy(r["Type of layoff or closure"]),
      // The date the state received the filing, which is not the date it
      // published it. Kept under its own name so it is never read as a posting.
      receivedDate: usDate(r["Date Received by NC"]) || null,
      postedDate: null,
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  // North Carolina publishes no reason for a layoff, so — unlike New York —
  // "reason" must not be listed here: a field that never exists cannot change.
  significant: ["noticeDate", "effectiveDate", "employeesAffected", "layoffOrClosure"],
  noise: [
    { op: "trimCase", path: "company" },
    { op: "trimCase", path: "siteAddress" },
    { op: "trimCase", path: "layoffOrClosure" },
    { op: "trimCase", path: "county" },
  ],
  presence: "closed_world",
  render(after) {
    const r = warnNoticeGap({
      jurisdiction: "US-NC",
      noticeDate: String(after.noticeDate),
      effectiveDate: String(after.effectiveDate),
    });
    return noticeSentence(String(after.company), Number(after.employeesAffected) || 0, String(after.siteAddress), r, "North Carolina");
  },
  health: { minRows: 0, expectedKeys: ["WARN Notice: WARN Notice Name", "Warn Number", "Date of Notice", "Effective Date"] },
  budget: { credits: 0, maxFetchesPerDay: 8 },
};
