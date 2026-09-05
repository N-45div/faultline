import { statuteName, warnNoticeGap } from "./rules";
import { startDateIsCertain, type LayoffNoticeRow } from "./receipt";

// The lawyer's export: one row per filing, every column a fact the state's
// file carries or a date we captured — never a conclusion. It deliberately
// has no "limitations date" column. Federal WARN sets no limitations period;
// courts borrow the most analogous state statute, which differs by state and
// circuit, and a number in that column would be a legal determination
// dressed as data. The notice date and the start date are here; the rest is
// the lawyer's.

export const CSV_COLUMNS = [
  "employer",
  "state",
  "site",
  "workers",
  "notice_date",
  "notice_month",
  "layoff_start",
  "layoff_start_as_written",
  "type",
  "stated_reason",
  "days_of_notice",
  "statute",
  "statute_days",
  "state_posted",
  "amendments",
  "file",
] as const;

export interface CsvOpts {
  /** The state file each row came from, for the last column. */
  fileFor: (row: LayoffNoticeRow) => string;
}

function cell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A row's edits, oldest first, in one cell: "field: before → after (seen 2026-09-02)". */
function amendmentsCell(row: LayoffNoticeRow): string {
  return (row.amendments ?? [])
    .flatMap((a) =>
      a.changed
        .filter((p) => String(a.before[p] ?? "") !== String(a.after[p] ?? ""))
        .map((p) => `${p}: ${String(a.before[p] ?? "—")} → ${String(a.after[p] ?? "—")} (seen ${new Date(a.at).toISOString().slice(0, 10)})`),
    )
    .join("; ");
}

export function layoffCsv(rows: LayoffNoticeRow[], opts: CsvOpts): string {
  const lines = [CSV_COLUMNS.join(",")];
  const sorted = [...rows].sort((a, b) => ((a.noticeDate || a.noticeMonth || "") < (b.noticeDate || b.noticeMonth || "") ? 1 : -1));
  for (const r of sorted) {
    const certain = startDateIsCertain(r.effectiveDateRaw);
    const g = warnNoticeGap({ jurisdiction: r.jurisdiction, noticeDate: r.noticeDate, effectiveDate: certain ? r.effectiveDate : "" });
    lines.push(
      [
        r.company,
        r.jurisdiction.replace(/^US-/, ""),
        r.siteAddress,
        r.workers,
        r.noticeDate,
        r.noticeMonth ?? "",
        certain ? r.effectiveDate : "",
        r.effectiveDateRaw ?? "",
        r.layoffOrClosure ?? "",
        r.reason ?? "",
        // Blank, not zero, when it cannot be counted: New Jersey publishes no
        // notice date, and a start date written as a list is not a date.
        g.verdict === "unknown" ? "" : g.actualDays,
        statuteName(r.jurisdiction),
        g.statutoryDays,
        r.postedIsProcessed ? "" : r.postedDate,
        amendmentsCell(r),
        opts.fileFor(r),
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * UTF-8 text to base64, with no runtime help. The mutation that answers an
 * email runs where there is no Buffer, and an attachment must be base64.
 */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }
  return out;
}
