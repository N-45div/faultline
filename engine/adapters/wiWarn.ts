import type { Fields, FetchBody, SourceAdapter } from "../types";
import { cellText, decodeEntities } from "../html";
import { leadingInt, slug, usDate } from "../canon";
import { noticeSentence, warnNoticeGap } from "../rules";

type Raw = {
  /** The state's own notice number: the row id and the PDF's name, e.g. 2026082401. */
  noticeId: string;
  /** The state's own revision number, from `?version=N` on the notice PDF. */
  version: number;
  company: string;
  /** A note the state prints beside the name: "the company provided a separate communication…". */
  note: string;
  city: string;
  employees: number;
  noticeDate: string;
  effectiveDate: string;
  noticeType: string;
  naics: string;
  county: string;
  area: string;
  /** Update codes the state lists for this notice this month: LS, AW, OC, RN. */
  updates: string[];
};

const PAGE = "https://dwd.wisconsin.gov/dislocatedworker/warn/";

/** The state's own codes, spelled out in its own legend. */
const NOTICE_TYPE: Record<string, string> = { CL: "Facility Closure", WR: "Workforce Reduction" };
export const UPDATE_TYPE: Record<string, string> = {
  AW: "Change to Number of Affected Workers",
  LS: "Change to Layoff Schedule",
  OC: "Other Change",
  RN: "Rescission of Notice",
};

const subjectKey = (r: Raw) => `${slug(r.company)}|${slug(r.city)}`;
const subjectLabel = (r: Raw) => `${r.company} — ${r.city} WI`;

/**
 * Wisconsin's WARN page — the one state that publishes its own revision
 * history. Every notice has a number (2026082401), every row links to the
 * PDF with `?version=N`, and a second table per month names which notices
 * were revised and how, in a four-code vocabulary the page's own legend
 * spells out: AW, LS, OC, RN. Where the other states overwrite a row and say
 * nothing, Wisconsin says "version 8, LS, AW" — which is the amendment chain
 * this product reconstructs elsewhere, published by the state itself. We
 * hold each version as the state numbers it.
 *
 * The page is one calendar year. This deployment cannot reach the host at
 * all — its DNS does not resolve from here — so Firecrawl fetches it and
 * hands back the HTML, which is parsed like any other state's table.
 */
export const wiWarn: SourceAdapter<Raw> = {
  id: "wi-warn",
  version: 1,
  publisher: "Wisconsin Department of Workforce Development",
  jurisdiction: "US-WI",
  datasetUrl: PAGE,
  pageUrl: PAGE,
  // Since 13 September the page builds its notice tables with its own script
  // after it loads: captured at once it is a heading, a legend and a list of
  // years, and zero rows. Eight seconds is enough for all fifty to be there.
  transport: { kind: "firecrawl_scrape", url: PAGE, formats: ["markdown"], creditsPerFetch: 1, waitForMs: 8_000, evidence: true },
  // Four reads a day: the page changes when the state posts, which is a few
  // times a month, and each read is a paid credit.
  cadence: { baseMs: 6 * 60 * 60_000, hotMs: 3 * 60 * 60_000, jitterPct: 20, gate: "always" },
  targeting: "whole_file",
  subjectKind: "employer_site",
  claimKind: "warn.notice",

  parse(body: FetchBody): Raw[] {
    if (body.kind !== "text") return [];
    return parseWisconsin(body.text);
  },
  identity: (r) => r.noticeId,
  subjectOf: (r) => ({ kind: "employer_site", key: subjectKey(r), label: subjectLabel(r) }),
  assertedAt: (r) => r.noticeDate,
  normalise(r): Fields {
    return {
      noticeId: r.noticeId,
      // The number on the PDF link's ?version= parameter, kept as served. It is
      // not a revision count: on 13 September the page republished with 42 of
      // them changed, 26 downward, and nothing else on the page changed. It is
      // dropped from every hash and never quoted. The state's record of its
      // revisions is its update table, below.
      version: r.version,
      company: r.company,
      note: r.note || null,
      siteAddress: `${r.city} WI`,
      city: r.city,
      county: r.county,
      workforceArea: r.area,
      noticeDate: r.noticeDate,
      effectiveDate: r.effectiveDate,
      employeesAffected: r.employees,
      layoffOrClosure: NOTICE_TYPE[r.noticeType] ?? r.noticeType,
      noticeType: r.noticeType,
      industry: r.naics,
      // What the state says changed, in its own codes and in its own words.
      updateCodes: r.updates.join(", ") || null,
      updates: r.updates.map((c) => UPDATE_TYPE[c] ?? c).join("; ") || null,
      postedDate: null,
      __subjectKind: "employer_site",
      __subjectKey: subjectKey(r),
      __subjectLabel: subjectLabel(r),
    };
  },
  significant: ["employeesAffected", "effectiveDate", "layoffOrClosure", "updateCodes"],
  noise: [
    { op: "drop", path: "version" },
    { op: "trimCase", path: "company" },
    { op: "trimCase", path: "siteAddress" },
    { op: "trimCase", path: "note" },
  ],
  // The whole year on one page: a row that leaves it has been withdrawn.
  presence: "open_world",
  render(after, before) {
    const g = warnNoticeGap({ jurisdiction: "US-WI", noticeDate: String(after.noticeDate), effectiveDate: String(after.effectiveDate) });
    const base = noticeSentence(String(after.company), Number(after.employeesAffected) || 0, String(after.siteAddress), g);
    if (before) {
      const what = after.updates ? ` Its update table records: ${String(after.updates)}.` : "";
      return `Wisconsin changed this notice in place.${what} ${base}`;
    }
    return `${base} Wisconsin's notice number ${String(after.noticeId)}.`;
  },
  health: { minRows: 20, expectedKeys: ["Company", "City", "Notice Received", "Layoff Begin Date"] },
  budget: { credits: 1, maxFetchesPerDay: 4 },
};

/**
 * The page by hand rather than through tableByHeaders, because the link is
 * the record: the notice number is the row's id and the PDF's name, and the
 * version is on the link. cellText would throw both away.
 */
export function parseWisconsin(html: string): Raw[] {
  // Update codes per notice, from every "Reason for Update" table on the page.
  const updates = new Map<string, Set<string>>();
  for (const table of html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? []) {
    if (!/Reason for Update/i.test(table)) continue;
    for (const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      const id = /#(\d{10})/.exec(row)?.[1];
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
      if (!id || cells.length < 2) continue;
      const set = updates.get(id) ?? new Set<string>();
      for (const code of cells[1].split(/[,\s]+/).filter(Boolean)) set.add(code.toUpperCase());
      updates.set(id, set);
    }
  }

  const out: Raw[] = [];
  const seen = new Set<string>();
  for (const table of html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? []) {
    if (!/Notice Received/i.test(table) || !/Layoff Begin Date/i.test(table)) continue;
    for (const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      const noticeId = /<tr\b[^>]*\bid="(\d{10})"/i.exec(row)?.[1];
      if (!noticeId || seen.has(noticeId)) continue;
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length < 9) continue;
      const version = Number(/[?&]version=(\d+)/.exec(cells[0])?.[1] ?? "1");
      const company = cellText(/<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(cells[0])?.[1] ?? cells[0]);
      const note = decodeEntities(cellText(cells[0].replace(/<a\b[^>]*>[\s\S]*?<\/a>/i, "")))
        .replace(/^\*\s*/, "")
        .trim();
      const noticeDate = usDate(cellText(cells[3]));
      if (!company || !noticeDate) continue;
      seen.add(noticeId);
      out.push({
        noticeId,
        version,
        company,
        note,
        city: cellText(cells[1]),
        employees: leadingInt(cellText(cells[2])),
        noticeDate,
        effectiveDate: usDate(cellText(cells[5])),
        noticeType: cellText(cells[4]).toUpperCase(),
        naics: cellText(cells[6]),
        county: cellText(cells[7]),
        area: cellText(cells[8]),
        updates: [...(updates.get(noticeId) ?? [])].sort(),
      });
    }
  }
  return out;
}
