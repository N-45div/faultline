import * as XLSX from "xlsx";
import type { Fields, FetchBody, SourceAdapter } from "../types";
import { firstUsDate, monthName, slug } from "../canon";
import { WARN_STATUTORY_DAYS } from "../rules";

// SheetJS needs the Node runtime: the action that fetches this file is "use node".

type Raw = {
  company: string;
  city: string;
  /** "2026-02" — the month, because that is all New Jersey publishes. */
  noticeMonth: string;
  monthPosted: string;
  year: string;
  /** The cell as written: a date, a range, a list, or "Rolling basis beginning on 6/4". */
  effectiveRaw: string;
  effectiveDate: string;
  employees: number;
  /** Which filing this is inside its company + city + month group. */
  ordinal: number;
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const str = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** Excel serial (days since 1899-12-30), or free text with a date somewhere in it. */
function anyDate(v: unknown): string {
  if (typeof v === "number" && v > 0) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000).toISOString().slice(0, 10);
  return firstUsDate(str(v));
}

const subjectKey = (r: Raw) => `${slug(r.company)}|${slug(r.city)}`;
const subjectLabel = (r: Raw) => `${r.company} — ${r.city} NJ`;

/**
 * New Jersey's WARN archive: one spreadsheet, one sheet per year back to 2004,
 * overwritten in place at the same URL.
 *
 * It is the most revealing file we hold, for what it leaves out. Every other
 * state publishes the date the employer's notice bears. New Jersey publishes
 * the month it posted the notice — "September" — and nothing else. So the one
 * number this whole product exists to compute, the days between notice and
 * layoff, cannot be computed here, and the receipt says exactly that instead
 * of inventing it. New Jersey's own act sets 90 days and, since April 2023,
 * severance of a week per year worked; the rule is named, never scored.
 *
 * The effective-date cell is a date, or a range, or a list of five dates, or
 * "Rolling basis beginning on 6/4". The first date in it is the one kept, and
 * the cell as written is kept beside it.
 */
export const njWarn: SourceAdapter<Raw> = {
  id: "nj-warn",
  version: 1,
  publisher: "New Jersey Department of Labor and Workforce Development",
  jurisdiction: "US-NJ",
  datasetUrl: "https://www.nj.gov/labor/assets/PDFs/WARN/WARN_Notice_Archive.xlsx",
  pageUrl: "https://www.nj.gov/labor/business-services/layoffs-and-closing/file-warn-notice/",
  transport: {
    kind: "http_binary",
    url: "https://www.nj.gov/labor/assets/PDFs/WARN/WARN_Notice_Archive.xlsx",
    decode: "xlsx",
    conditional: { etag: true, treat304As: "no_change" },
  },
  cadence: { baseMs: 6 * 60 * 60_000, hotMs: 3 * 60 * 60_000, jitterPct: 20, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "bytes") return [];
    const wb = XLSX.read(body.bytes, { type: "array", cellDates: false });
    const out: Raw[] = [];
    // One filing can appear twice in a company's month — two waves, two rows.
    // The ordinal keeps them apart without putting a value in the identity
    // that the state might later correct.
    const seen = new Map<string, number>();
    for (const name of wb.SheetNames) {
      const year = /^\s*(\d{4})/.exec(name)?.[1];
      if (!year) continue;
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: "" });
      for (const raw of rows) {
        const company = str(raw.Company);
        const city = str(raw.City);
        if (!company || /^company$/i.test(company)) continue;
        // A sheet footnote is not an employer. New Jersey's 2009 sheet ends
        // with "* Most employees of companies marked with asterisk will be
        // rehired by buyer" in the company column; a row that names no place,
        // no date and nobody is not a filing. Rows with a blank headcount ARE
        // kept — the state leaving the number out is itself the record.
        if (!city && !str(raw["Effective Date"]) && !Number(raw["Workforce Affected"])) continue;
        const monthPosted = str(raw["Month Posted"]);
        const monthIdx = MONTHS.indexOf(monthPosted.toLowerCase());
        const noticeMonth = monthIdx >= 0 ? `${year}-${String(monthIdx + 1).padStart(2, "0")}` : "";
        const key = `${slug(company)}|${slug(city)}|${year}|${monthPosted.toLowerCase()}`;
        const ordinal = (seen.get(key) ?? 0) + 1;
        seen.set(key, ordinal);
        out.push({
          company,
          city,
          noticeMonth,
          monthPosted,
          year,
          effectiveRaw: str(raw["Effective Date"]),
          effectiveDate: anyDate(raw["Effective Date"]),
          employees: Number(raw["Workforce Affected"]) || 0,
          ordinal,
        });
      }
    }
    return out;
  },
  // No id, no notice date: the identity is the company, the place, the month
  // the state posted it, and which filing of that month this is. Everything
  // the state can correct — the start date, the headcount — stays out of it,
  // so a correction reads as an amendment and not as a row replaced.
  identity: (r) => `${subjectKey(r)}|${r.year}|${r.monthPosted.toLowerCase()}|${r.ordinal}`,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  // The month, floored to its first day, because the record bears a month and
  // no day. It is never rendered: the receipt says "posted in February 2026".
  assertedAt: (r) => (r.noticeMonth ? `${r.noticeMonth}-01` : `${r.year}-01-01`),
  normalise(r): Fields {
    return {
      company: r.company,
      // New Jersey gives a municipality, not a street address.
      siteAddress: `${r.city} NJ`,
      city: r.city,
      // The absent field, named so a reader of the stored row sees the hole.
      noticeDate: "",
      noticeMonth: r.noticeMonth,
      effectiveDate: r.effectiveDate,
      effectiveDateRaw: r.effectiveRaw,
      employeesAffected: r.employees,
      postedDate: null,
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  // A corrected start date or headcount is the news here; the raw cell moves
  // with the parsed date, so it is stored but never emits on its own.
  significant: ["effectiveDate", "employeesAffected", "noticeMonth"],
  noise: [
    { op: "trimCase", path: "company" },
    { op: "trimCase", path: "siteAddress" },
    { op: "trimCase", path: "city" },
    { op: "trimCase", path: "effectiveDateRaw" },
  ],
  // Cumulative back to 2004: a row that leaves this file really is gone.
  presence: "open_world",
  render(after) {
    const people = Number(after.employeesAffected) || 0;
    const month = String(after.noticeMonth ?? "");
    const when = monthName(month) ? `posted by New Jersey in ${monthName(month)}` : "in New Jersey's file";
    const start = after.effectiveDate ? `, starting ${String(after.effectiveDate)}` : "";
    return (
      `${String(after.company)} filed a WARN notice for ${String(after.siteAddress)}, ${people} ${people === 1 ? "worker" : "workers"}${start} — ${when}. ` +
      `New Jersey publishes no notice date, so the ${WARN_STATUTORY_DAYS["US-NJ"]} days its own act requires cannot be counted from this file.`
    );
  },
  // ~2,300 rows across 23 sheets. A collapse means a broken read, not a state
  // that deleted twenty years of notices.
  health: { minRows: 1500, expectedKeys: ["Company", "City", "Month Posted", "Effective Date", "Workforce Affected"] },
  budget: { credits: 0, maxFetchesPerDay: 8 },
};
