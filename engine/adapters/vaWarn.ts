import type { Fields, FetchBody, SourceAdapter } from "../types";
import { csvToObjects } from "../csv";
import { leadingInt, slug, usDate } from "../canon";
import { decodeEntities } from "../html";
import { noticeSentence, warnNoticeGap } from "../rules";

type Raw = Record<string, string>;

const REJECT = ["<html", "<!doctype"];

const PAGE = "https://virginiaworks.gov/im-an-employer/retain-and-grow/warn-notices/";

// Virginia's location cells arrive double-escaped: "Maidens &amp;amp; Henrico".
const tidy = (s: string) => decodeEntities(decodeEntities(s ?? "")).replace(/\s+/g, " ").trim();

const subjectKey = (r: Raw) => `${slug(tidy(r.Company))}|${slug(tidy(r.Location))}`;
const subjectLabel = (r: Raw) => `${tidy(r.Company)} — ${tidy(r.Location)}`;

/**
 * Virginia mints the CSV afresh on every render of its page, names it for the
 * server's epoch second, and deletes the old one within hours — a URL from
 * yesterday is a 404. So the page is read first and the link taken from it.
 */
function findCsvLink(html: string): string | null {
  const m = /warn_notices_\d+\.csv/i.exec(html);
  return m ? `https://virginiaworks.gov/${m[0]}` : null;
}

/**
 * The union local, without the officer's name and postal address that Virginia
 * prints beside it. That a union represented these workers is the part a laid-
 * off person needs; a named individual's address is not ours to republish.
 */
function unionOf(raw: string): string {
  const text = tidy(raw);
  if (!text) return "";
  return text.split(",")[0].trim();
}

/**
 * Virginia's WARN notices. The deepest file we hold — 1,100-odd notices going
 * back to 2010, where the other states publish one year at a time.
 *
 * Virginia has no state WARN act; the federal 60 days applies.
 *
 * The file also names a contact person at each employer. That column is read
 * and dropped here: it is one named private individual per row, it is no part
 * of what a laid-off worker needs, and a record we do not keep cannot leak.
 */
export const vaWarn: SourceAdapter<Raw> = {
  id: "va-warn",
  version: 1,
  publisher: "Virginia Employment Commission (Virginia Works)",
  jurisdiction: "US-VA",
  datasetUrl: PAGE,
  pageUrl: PAGE,
  transport: {
    kind: "http_text",
    // Minted names die within hours; this one is almost certainly already gone,
    // and exists only so the shape of the URL is on the record.
    url: "https://virginiaworks.gov/warn_notices_1788234937.csv",
    format: "csv",
    rejectIfMatches: REJECT,
    discover: { pageUrl: PAGE, find: findCsvLink },
  },
  cadence: { baseMs: 6 * 60 * 60_000, hotMs: 3 * 60 * 60_000, jitterPct: 20, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    const head = body.text.slice(0, 2000).toLowerCase();
    if (REJECT.some((m) => head.includes(m))) return [];
    return csvToObjects(body.text).filter((r) => r.Company && usDate(r["Notice Date"]));
  },
  // Virginia publishes no id in the CSV, so the identity is composed. The
  // impact date is part of it because one employer files repeatedly for the
  // same site on the same day for different waves.
  identity: (r) =>
    `${subjectKey(r)}|${usDate(r["Notice Date"])}|${usDate(r["Impact Date"])}|${leadingInt(r["Employees Affected"])}`,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  assertedAt: (r) => usDate(r["Notice Date"]),
  normalise(r): Fields {
    const union = unionOf(r["Collective Bargaining Unit"]);
    return {
      company: tidy(r.Company),
      noticeDate: usDate(r["Notice Date"]),
      effectiveDate: usDate(r["Impact Date"]),
      siteAddress: tidy(r.Location),
      employeesAffected: leadingInt(r["Employees Affected"]),
      layoffOrClosure: tidy(r["Notice Type"]),
      // Whether anyone was represented, without naming the officer.
      union: union || null,
      represented: Boolean(union),
      // Virginia publishes no posting date in the file itself.
      postedDate: null,
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  significant: ["noticeDate", "effectiveDate", "employeesAffected", "layoffOrClosure"],
  noise: [
    { op: "trimCase", path: "company" },
    { op: "trimCase", path: "siteAddress" },
    { op: "trimCase", path: "layoffOrClosure" },
    { op: "trimCase", path: "union" },
  ],
  // Cumulative back to 2010, so a row leaving it is a real deletion.
  presence: "open_world",
  render(after) {
    const r = warnNoticeGap({
      jurisdiction: "US-VA",
      noticeDate: String(after.noticeDate),
      effectiveDate: String(after.effectiveDate),
    });
    const base = noticeSentence(String(after.company), Number(after.employeesAffected) || 0, String(after.siteAddress), r, "Virginia");
    return after.union ? `${base} The notice names ${String(after.union)} as the bargaining unit.` : base;
  },
  // Virginia's file is cumulative back to 2010, so unlike the year-scoped
  // states a collapse in row count really is a broken fetch.
  health: { minRows: 500, expectedKeys: ["Company", "Notice Date", "Impact Date", "Employees Affected", "Location"] },
  budget: { credits: 0, maxFetchesPerDay: 8 },
};
