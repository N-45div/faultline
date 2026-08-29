import * as XLSX from "xlsx";
import type { Fields, FetchBody, SourceAdapter } from "../types";
import { slug } from "../canon";
import { noticeSentence, warnNoticeGap } from "../rules";

// SheetJS needs the Node runtime: the action that fetches this file is "use node".

type Raw = {
  county: string;
  noticeDate: string;
  processedDate: string;
  effectiveDate: string;
  company: string;
  layoffOrClosure: string;
  employees: number;
  address: string;
  industry: string;
};

const subjectKey = (r: Raw) => `${slug(r.company)}|${slug(r.address)}`;
const subjectLabel = (r: Raw) => `${r.company} — ${r.address}`;

/**
 * California EDD WARN report. One filename, overwritten in place, no history
 * anywhere. A conditional GET returns 304 with zero bytes when unchanged — a
 * free, perfect "nothing moved" proof. The file is a rolling window filtered
 * by processed date, so rows genuinely fall off the front.
 */
export const caWarn: SourceAdapter<Raw> = {
  id: "ca-warn",
  version: 1,
  publisher: "California Employment Development Department",
  jurisdiction: "US-CA",
  datasetUrl: "https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN/",
  transport: {
    kind: "http_binary",
    url: "https://edd.ca.gov/siteassets/files/jobs_and_training/warn/warn_report1.xlsx",
    decode: "xlsx",
    conditional: { etag: true, treat304As: "no_change" },
  },
  cadence: { baseMs: 30 * 60_000, hotMs: 15 * 60_000, jitterPct: 15, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "bytes") return [];
    const wb = XLSX.read(body.bytes, { type: "array", cellDates: false });
    // The sheet name carries a trailing space in the published file.
    const name = wb.SheetNames.find((n) => n.trim().toLowerCase() === "detailed warn report");
    if (!name) return [];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, blankrows: false });
    const headerIdx = rows.findIndex((r) => String(r?.[0] ?? "").trim().toLowerCase() === "county/parish");
    if (headerIdx < 0) return [];
    return rows
      .slice(headerIdx + 1)
      .filter((r) => r && r[4])
      .map((r) => ({
        county: str(r[0]),
        noticeDate: excelDate(r[1]),
        processedDate: excelDate(r[2]),
        effectiveDate: excelDate(r[3]),
        company: str(r[4]),
        layoffOrClosure: str(r[5]),
        employees: Number(r[6]) || 0,
        address: str(r[7]),
        industry: str(r[8]),
      }));
  },
  identity: (r) => `${subjectKey(r)}|${r.noticeDate}`,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  assertedAt: (r) => r.noticeDate,
  normalise(r): Fields {
    return {
      company: r.company,
      county: r.county,
      noticeDate: r.noticeDate,
      processedDate: r.processedDate,
      effectiveDate: r.effectiveDate,
      layoffOrClosure: r.layoffOrClosure,
      employeesAffected: r.employees,
      siteAddress: r.address,
      industry: r.industry,
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  significant: ["noticeDate", "effectiveDate", "employeesAffected", "layoffOrClosure"],
  noise: [{ op: "trimCase", path: "layoffOrClosure" }],
  presence: "open_world",
  render(after) {
    const r = warnNoticeGap({
      jurisdiction: "US-CA",
      noticeDate: String(after.noticeDate),
      effectiveDate: String(after.effectiveDate),
      postedDate: after.processedDate ? String(after.processedDate) : undefined,
    });
    return noticeSentence(String(after.company), Number(after.employeesAffected), String(after.siteAddress), r, "California");
  },
  health: { minRows: 50, expectedKeys: ["company", "noticeDate", "effectiveDate"] },
  budget: { credits: 0, maxFetchesPerDay: 96 },
};

function str(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/** Excel serial (days since 1899-12-30) or an already-formatted string → YYYY-MM-DD. */
function excelDate(v: unknown): string {
  if (typeof v === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s.slice(0, 10);
}
