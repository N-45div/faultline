import type { Fields, FetchBody, SourceAdapter } from "../types";
import { csvToObjects } from "../csv";
import { slug } from "../canon";
import { noticeSentence, warnNoticeGap } from "../rules";

type Raw = Record<string, string>;

// A WAF challenge comes back as HTML with a 200. Any of these in the first
// 2 KB means the body is not the CSV.
const REJECT = ["<html", "<!doctype", "captcha", "awswaf", "challenge"];

const subjectKey = (r: Raw) => `${slug(r["Business Legal Name"])}|${slug(r["Impacted Site Address"])}`;
const subjectLabel = (r: Raw) => `${r["Business Legal Name"]} — ${r["Impacted Site Address"]}`;

/**
 * New York State WARN notices. The page is a Tableau embed; the CSV export
 * behind it is open. The ?:showVizHome=no suffix is load-bearing — without it
 * the same path returns a WAF captcha shell.
 */
export const nyWarn: SourceAdapter<Raw> = {
  id: "ny-warn",
  version: 1,
  publisher: "New York State Department of Labor",
  jurisdiction: "US-NY",
  datasetUrl: "https://dol.ny.gov/warn-notices",
  transport: {
    kind: "http_text",
    url: "https://public.tableau.com/views/WorkerAdjustmentRetrainingNotificationWARN/WARN.csv?:showVizHome=no",
    format: "csv",
    rejectIfMatches: REJECT,
  },
  cadence: { baseMs: 60 * 60_000, hotMs: 30 * 60_000, jitterPct: 15, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    const head = body.text.slice(0, 2000).toLowerCase();
    if (REJECT.some((m) => head.includes(m))) return [];
    return csvToObjects(body.text).filter((r) => r["Business Legal Name"] && r["Date of WARN Notice"]);
  },
  identity: (r) => `${subjectKey(r)}|${r["Date of WARN Notice"]}`,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  assertedAt: (r) => r["Date of WARN Notice"],
  normalise(r): Fields {
    return {
      company: r["Business Legal Name"],
      noticeDate: r["Date of WARN Notice"],
      effectiveDate: r["Date Layoff/Closure Starts"],
      postedDate: r["Date Posted"],
      siteAddress: r["Impacted Site Address"],
      county: r["Impacted Site County"],
      layoffOrClosure: r["Layoff or Closure?"],
      permanentOrTemporary: r["Permanent or Temporary Layoff?"],
      reason: r["Reason for Layoff/Closure"],
      employeesAffected: Number(r["Number of Affected Workers"]) || 0,
      index: r["Index"] ?? "",
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  significant: ["noticeDate", "effectiveDate", "employeesAffected", "reason"],
  noise: [{ op: "trimCase", path: "reason" }],
  presence: "open_world",
  render(after) {
    const r = warnNoticeGap({
      jurisdiction: "US-NY",
      noticeDate: String(after.noticeDate),
      effectiveDate: String(after.effectiveDate),
      postedDate: after.postedDate ? String(after.postedDate) : undefined,
    });
    return noticeSentence(String(after.company), Number(after.employeesAffected), String(after.siteAddress), r, "New York");
  },
  // A captcha shell parses to 0 rows; the real file has ~190. Below 100 the
  // cycle is degraded and nothing is recorded as removed.
  health: { minRows: 100, expectedKeys: ["Business Legal Name", "Date of WARN Notice", "Date Layoff/Closure Starts"] },
  budget: { credits: 0, maxFetchesPerDay: 48 },
};
