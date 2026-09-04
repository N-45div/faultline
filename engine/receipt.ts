import { daysBetween, foldString, monthName, usDate } from "./canon";
import { FEDERAL_WARN_THRESHOLD, OWN_ACT, WARN_EXCEPTIONS, noticePhrase, statuteName, warnNoticeGap, type NoticeGapResult } from "./rules";

// The receipt is the product. Every word here is read by someone who got a
// letter this month, so it uses the record's own words and never a verdict.

/**
 * One in-place edit the state made to a notice, as we saw it: which fields
 * moved, from what to what, and when we caught it. The version before is kept.
 */
export interface Amendment {
  at: number;
  changed: string[];
  before: Record<string, string | number | boolean | null>;
  after: Record<string, string | number | boolean | null>;
}

export interface LayoffNoticeRow {
  company: string;
  siteAddress: string;
  workers: number;
  noticeDate: string;
  effectiveDate: string;
  postedDate: string;
  /**
   * True when the state publishes the day it put the notice online. California
   * publishes the day it processed one, which is a different act by a
   * different clock, and must not be read as "the state was slow to publish".
   */
  postedIsProcessed?: boolean;
  jurisdiction: "US-NY" | "US-CA" | "US-MD" | "US-CO" | "US-NC" | "US-VA" | "US-NJ";
  /**
   * "2026-02", when the state publishes only the month it posted the notice
   * and never the day. New Jersey is the only one so far.
   */
  noticeMonth?: string;
  /**
   * The start-date cell exactly as the state wrote it. Often a single date,
   * sometimes a range, sometimes a list of twelve, sometimes written
   * backwards. Kept so the receipt can show the cell instead of asserting one
   * date out of several.
   */
  effectiveDateRaw?: string;
  layoffOrClosure?: string;
  reason?: string;
  amendments?: Amendment[];
}

const FIELD_WORDS: Record<string, string> = {
  effectiveDate: "the layoff start date",
  noticeDate: "the notice date",
  employeesAffected: "the number of workers",
  reason: "the stated reason",
  layoffOrClosure: "the type of action",
};

/**
 * The amendment chain, in words. States edit notices in place; the diff
 * between versions is the thing a lawyer asks for, so it is spelled out with
 * both values and the day we caught it. A later start date gets the federal
 * rule beside it — the rule, never a verdict.
 */
export function amendmentLines(a: Amendment): string[] {
  const parts: string[] = [];
  for (const path of a.changed.filter((p) => FIELD_WORDS[p])) {
    const from = String(a.before[path] ?? "—");
    const to = String(a.after[path] ?? "—");
    if (from === to) continue;
    parts.push(`${FIELD_WORDS[path]} from ${from} to ${to}`);
  }
  if (parts.length === 0) return [];
  const seen = new Date(a.at).toISOString().slice(0, 10);
  const lines = [`Amended by the state: ${parts.join("; ")}. We saw the change on ${seen}; the version before it is kept.`];
  const b = String(a.before.effectiveDate ?? "");
  const c = String(a.after.effectiveDate ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(b) && /^\d{4}-\d{2}-\d{2}$/.test(c) && c > b) {
    const moved = Math.round((Date.parse(c) - Date.parse(b)) / 86_400_000);
    lines.push(
      `The start moved ${moved} ${moved === 1 ? "day" : "days"} later. Federal rules say a postponement of more than 60 days needs a fresh notice; whether one was given is a question for a lawyer.`,
    );
  }
  return lines;
}

export interface BuildingStamp {
  status: string;
  date: string;
  hazardClass: string;
  certifiedBy: string | null;
  violationId?: string;
  /** The city's own words for what was wrong. */
  description?: string | null;
  inspected?: string | null;
}

export interface Receipt {
  kind: "layoff" | "building" | "none";
  query: string;
  subjectKey?: string;
  headline: string;
  blocks: string[][];
  links: { label: string; url: string }[];
  footer: string[];
}

export interface ReceiptOpts {
  versionsSince: string;
  pageUrl?: string;
  /** The last full read of each file this receipt draws on. */
  provenance?: { publisher: string; url: string; at: number; status: number; rows: number; lastChecked: number; coverage?: string }[];
  /** What we hold for this subject: rows, versions of them, reads of the file since. */
  held?: { rows: number; versions: number; reads: number; since: number | null };
}

const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

/**
 * The two lines that turn "we keep every version" from a claim into a count,
 * and say where the rows came from. Shared by every receipt.
 */
function heldLines(opts: ReceiptOpts): string[] {
  const out: string[] = [];
  const h = opts.held;
  if (h && h.rows > 0 && h.since !== null) {
    const since = h.since;
    out.push(
      // "the file" is several files when an employer filed in several states,
      // and the sum of their read counts is nobody's number.
      `We hold ${h.rows} ${h.rows === 1 ? "row" : "rows"} for this, in ${h.versions} ${h.versions === 1 ? "version" : "versions"}, across ${(opts.provenance ?? []).length || 1} ${((opts.provenance ?? []).length || 1) === 1 ? "file" : "files"} read ${h.reads} ${h.reads === 1 ? "time" : "times"} between them since ${stamp(since).slice(0, 10)}.`,
    );
  }
  for (const p of opts.provenance ?? []) {
    out.push(`Read from ${p.publisher}'s file on ${stamp(p.at)} (HTTP ${p.status}, ${p.rows.toLocaleString()} rows); last checked ${stamp(p.lastChecked)}. ${p.url}`);
  }
  return out;
}

const STATE = { "US-NY": "New York", "US-CA": "California", "US-MD": "Maryland", "US-CO": "Colorado", "US-NC": "North Carolina", "US-VA": "Virginia", "US-NJ": "New Jersey" } as const;
const STATE_PAGE = {
  "US-NY": "https://dol.ny.gov/warn-notices",
  "US-CA": "https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN/",
  "US-MD": "https://labor.maryland.gov/employment/warn.shtml",
  "US-CO": "https://cdle.colorado.gov/employers/layoff-separations/layoff-warn-list",
  "US-NC": "https://www.commerce.nc.gov/data-tools-reports/labor-market-data-tools/workforce-warn-reports/report-workforce-warn-summary-list-2026",
  "US-VA": "https://virginiaworks.gov/im-an-employer/retain-and-grow/warn-notices/",
  "US-NJ": "https://www.nj.gov/labor/business-services/layoffs-and-closing/file-warn-notice/",
} as const;



const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** The rule in the state's own name, for receipts that cannot count against it. */
const OWN_ACT_LINE: Partial<Record<LayoffNoticeRow["jurisdiction"], string>> = {
  "US-NJ": "New Jersey's own WARN Act sets 90 days, and since April 2023 severance of a week per year worked.",
};

/**
 * Whether the one start date we parsed is the whole of what the state wrote.
 *
 * Maryland writes ranges, sometimes backwards ("03/31/2026 - 06/30/2025"), and
 * measuring to the first date there turned a 214-day gap into "inside the
 * statute". New Jersey writes lists — "3/31/26 (Paramus and Ramsey), 4/30/26
 * (Livingston)" — and a Livingston worker's date is not the first one. A
 * proper range is fine: its first date is the start. Anything else is the
 * state saying more than one thing, and the receipt shows the cell rather than
 * choosing for it.
 */
export function startDateIsCertain(raw: string | undefined): boolean {
  const cell = (raw ?? "").trim();
  if (!cell) return true;
  const found = cell.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) ?? [];
  if (found.length <= 1) return true;
  if (found.length > 2) return false;
  // Two dates joined by a dash, and in order: a range, whose start is the first.
  const isRange = /\d\s*(?:-|–|—|to|through)\s*\d/i.test(cell);
  return isRange && usDate(found[0] ?? "") <= usDate(found[1] ?? "");
}

/** A house number and a street: what the federal single-site rule needs. */
function hasStreetAddress(site: string): boolean {
  return /\d/.test(site) && /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|ct|court|pl|place|ter|terrace|cir|circle|sq|square|route|rt|suite|ste|floor|fl)\b/i.test(site);
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/**
 * Federal rules count separate layoffs at one site within any 90-day period
 * together (29 U.S.C. § 2102(d)); a state's file shows them as unrelated rows.
 * This is the line that puts them back side by side: which notice this is at
 * the address, over how many days, and the workers across all of them. Rows
 * are matched by state and address as the state wrote them — no fuzzing, so
 * two spellings of one site stay two sites and the count is never inflated.
 */
export function aggregationLine(row: LayoffNoticeRow, rows: LayoffNoticeRow[]): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.noticeDate)) return null;
  // The federal rule aggregates at a single site of employment. Colorado
  // publishes a workforce area, Virginia a locality, New Jersey a list of
  // municipalities — "Pueblo" is not an address, and two notices there need
  // not be the same site at all. Only files that give a street address can
  // support this sentence.
  if (!hasStreetAddress(row.siteAddress)) return null;
  const site = foldString(row.siteAddress);
  const window = rows.filter(
    (r) =>
      r !== row &&
      r.jurisdiction === row.jurisdiction &&
      foldString(r.siteAddress) === site &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.noticeDate) &&
      r.noticeDate <= row.noticeDate &&
      // Two notices 90 days apart span 91 days, which is not "within any
      // 90-day period".
      daysBetween(r.noticeDate, row.noticeDate) < 90,
  );
  if (window.length === 0) return null;
  const all = [...window, row];
  const workers = all.reduce((n, r) => n + r.workers, 0);
  const earliest = all.map((r) => r.noticeDate).sort()[0];
  const span = daysBetween(earliest, row.noticeDate);
  const rule = "Federal rules count separate layoffs at one site within any 90-day period together; whether that changes the notice owed is a question for a lawyer.";
  if (span === 0) return `One of ${all.length} notices at this address dated the same day, ${workers} workers together. ${rule}`;
  return `${ordinal(all.length)} notice at this address in ${span} days; ${workers} workers across them. ${rule}`;
}

/**
 * What a state's recorded reason has to say to count as naming an exception.
 * Matched on the phrase, never on its first word: Colorado writes its reasons
 * in free text, and "natural gas plant shutdown" contains "natural" without
 * naming a natural disaster. Claiming an employer invoked a legal exception
 * they never invoked is the worst thing this receipt could do.
 */
const EXCEPTION_PATTERNS: Record<string, RegExp> = {
  "faltering company": /\bfaltering\b/i,
  "unforeseeable business circumstances": /\bunforesee(?:n|able)\b/i,
  "natural disaster": /\bnatural disaster\b|\b(?:hurricane|flood|earthquake|wildfire|tornado)\b/i,
  "strike or lockout": /\bstrike\b|\block[- ]?out\b/i,
  "physical calamity or act of war": /\bphysical calamity\b|\bact of war\b/i,
  "faltering company seeking capital (closures only)": /\bfaltering\b/i,
};

/**
 * When notice fell short of the statute, the rule allows it only for a named
 * exception, and requires the notice to state the basis. The state's file
 * either records a reason or it does not; this line says which, and whether
 * the words it recorded name an exception. What the notice itself said is on
 * the notice — this is the record, not a verdict.
 */
export function exceptionLine(row: LayoffNoticeRow, gap: Pick<NoticeGapResult, "verdict" | "jurisdiction">): string | null {
  if (gap.verdict !== "gap") return null;
  const state = STATE[row.jurisdiction];
  const exceptions = WARN_EXCEPTIONS[gap.jurisdiction] ?? WARN_EXCEPTIONS["US"];
  const list = `${exceptions.slice(0, -1).join(", ")} or ${exceptions.at(-1)}`;
  const reason = (row.reason ?? "").trim();
  if (!reason || /^(not specified|n\/a|none|unknown|other)$/i.test(reason)) {
    return `${state}'s file records no reason${reason ? ` ("${reason}")` : ""}. The rule allows shorter notice only for ${list}, and requires the notice itself to state the basis.`;
  }
  const named = exceptions.find((e) => EXCEPTION_PATTERNS[e]?.test(reason) ?? false);
  if (named) {
    return `The reason ${state} recorded, "${reason}", names the "${named}" exception. The rule also requires the notice to state the basis for it; the state's file holds only these words.`;
  }
  return `The reason ${state} recorded, "${reason}", names none of the exceptions the rule allows for shorter notice (${list}).`;
}

export function layoffReceipt(query: string, subjectKey: string, rows: LayoffNoticeRow[], opts: ReceiptOpts): Receipt {
  const scored = rows
    .map((r) => ({
      r,
      certain: startDateIsCertain(r.effectiveDateRaw),
      g: warnNoticeGap({
        jurisdiction: r.jurisdiction,
        noticeDate: r.noticeDate,
        // An uncertain start date is no start date: the gap comes back
        // "unknown" rather than measured against a date we chose.
        effectiveDate: startDateIsCertain(r.effectiveDateRaw) ? r.effectiveDate : "",
        postedDate: r.postedDate || undefined,
      }),
    }))
    // Shortest notice first — that is what a person opens the receipt for. A
    // filing whose notice period cannot be counted sorts last: an uncountable
    // gap is not a zero-day one.
    .sort((a, b) => {
      const unknown = (x: { g: { verdict: string } }) => (x.g.verdict === "unknown" ? 1 : 0);
      return unknown(a) - unknown(b) || a.g.actualDays - b.g.actualDays || b.r.workers - a.r.workers;
    });

  const first = scored[0];
  const totalWorkers = rows.reduce((n, r) => n + r.workers, 0);
  // Count filings, not distinct addresses: two Richmond filings are two filings.
  const filings = rows.length;
  // Every state present, largest first — the headline and the links must name
  // all of them, or a lawyer who checks one state's page finds the wrong count.
  const byState = new Map<LayoffNoticeRow["jurisdiction"], number>();
  for (const r of rows) byState.set(r.jurisdiction, (byState.get(r.jurisdiction) ?? 0) + r.workers);
  const states = [...byState.entries()].sort((a, b) => b[1] - a[1]).map(([j]) => j);
  const stateNames = states.map((j) => STATE[j]);
  const stateList = stateNames.length <= 1 ? stateNames[0] : `${stateNames.slice(0, -1).join(", ")} and ${stateNames.at(-1)}`;
  const years = rows.map((r) => (r.noticeDate || r.noticeMonth || "").slice(0, 4)).filter(Boolean).sort();
  const span = years.length > 1 && years[0] !== years.at(-1) ? `, ${years[0]}–${years.at(-1)}` : "";
  const headline =
    filings > 1
      ? `${first.r.company} — ${filings} filings in ${stateList}, ${totalWorkers} workers${span}.`
      : `${first.r.company} — ${first.r.siteAddress}. ${first.r.workers} ${first.r.workers === 1 ? "worker" : "workers"}.`;

  // The sentence explaining why a state's file carries no notice date is long,
  // and true of every one of that state's filings. Once is information; on
  // eleven blocks in a row it is wallpaper, and a reader skips the line that
  // matters most. Said on that state's first block, and not again.
  const explained = new Set<string>();
  const blocks = scored.slice(0, 5).map(({ r, g, certain }) => {
    const state = STATE[r.jurisdiction];
    const event = r.layoffOrClosure?.toLowerCase().includes("closure") ? "closure" : "layoff";
    const kind = [r.layoffOrClosure, r.reason].filter(Boolean).join(" · ");
    const people = `${r.workers} ${r.workers === 1 ? "worker" : "workers"}`;
    const siteLine =
      filings > 1
        ? `${states.length > 1 ? `${state} · ` : ""}${r.siteAddress} — ${people}${kind ? ` · ${kind}` : ""}`
        : kind;
    const phrase = noticePhrase(g.actualDays);
    // A state that publishes no notice date gets no notice count. The rule is
    // still named, because the rule is the state's; the number would be ours.
    const firstOfState = g.verdict === "unknown" && !explained.has(r.jurisdiction);
    if (g.verdict === "unknown") explained.add(r.jurisdiction);
    // The statute is named by whoever actually wrote it. Virginia, Colorado and
    // North Carolina have no WARN act of their own; the federal 60 days is the
    // whole rule there, and saying otherwise invents a law.
    const statute = statuteName(r.jurisdiction);
    const noticeLine =
      g.verdict === "unknown"
        ? !certain
          ? `The notice period cannot be counted while the start date is written this way. ${OWN_ACT_LINE[r.jurisdiction] ?? `${statuteName(r.jurisdiction)} sets ${g.statutoryDays} days.`}`
          : firstOfState
            ? `${state} publishes the month it posted a notice, not the date the employer gave it, so the notice period cannot be counted from the state's file. ${OWN_ACT_LINE[r.jurisdiction] ?? `Federal WARN sets ${g.statutoryDays} days.`}`
            : ""
        : g.verdict === "gap"
          ? `${phrase[0].toUpperCase()}${phrase.slice(1)}. ${statute} sets ${g.statutoryDays} days${OWN_ACT[r.jurisdiction] ? "" : `; ${state} has no WARN act of its own`}.`
          : `${phrase[0].toUpperCase()}${phrase.slice(1)} — inside the ${g.statutoryDays} days ${statute} sets.`;
    // When the cell holds more than one date, the cell is what is shown.
    const started = !certain
      ? `${state}'s file gives the start as "${(r.effectiveDateRaw ?? "").trim()}".`
      : r.effectiveDate
        ? `${event === "closure" ? "Closure" : "Layoff"} started ${r.effectiveDate}.`
        : `${state}'s file gives no start date.`;
    const dateLine = r.noticeDate
      ? `Notice dated ${r.noticeDate}. ${started}`
      : `${monthName(r.noticeMonth ?? "") ? `Posted by ${state} in ${monthName(r.noticeMonth ?? "")}` : `${state} gives no notice date`}. ${started}`;
    const lines = [siteLine, dateLine, noticeLine].filter(Boolean);
    // Below the federal headcount, the statutory paragraph is withheld: the
    // state lists filings its own act does not reach, and scoring one of those
    // against the rule reads as an accusation the record cannot support.
    const small = r.workers > 0 && r.workers < FEDERAL_WARN_THRESHOLD;
    if (small && g.verdict === "gap") {
      lines.push(
        `${r.workers} ${r.workers === 1 ? "worker" : "workers"} — below the ${FEDERAL_WARN_THRESHOLD} the federal act normally requires notice for at one site. States list filings their own statutes do not reach, so whether notice was owed here is a question for a lawyer.`,
      );
    } else {
      const exception = exceptionLine(r, g);
      if (exception) lines.push(exception);
    }
    const together = aggregationLine(r, rows);
    if (together) lines.push(together);
    if (g.postingLagDays !== null) {
      const posted = r.postedIsProcessed
        ? `${state}'s file says it processed this on ${r.postedDate}, ${days(g.postingLagDays)} after the notice`
        : `${state} put this online on ${r.postedDate}, ${days(g.postingLagDays)} after the notice`;
      lines.push(g.postedAfterEffective && !r.postedIsProcessed ? `${posted} — after the ${event} had started.` : `${posted}.`);
    }
    for (const a of r.amendments ?? []) lines.push(...amendmentLines(a));
    return lines.filter(Boolean);
  });
  const rest = scored.length - 5;
  if (rest > 0) blocks.push([`…and ${rest} more ${rest === 1 ? "filing" : "filings"}.`]);

  // One link per state present, so every worker count above can be checked.
  const links: Receipt["links"] = states.map((j) => ({
    label: states.length > 1 ? `Check it on ${STATE[j]}'s page` : "Check it on the state's page",
    url: STATE_PAGE[j],
  }));
  if (opts.pageUrl) links.push({ label: "This employer's page", url: opts.pageUrl });

  return {
    kind: "layoff",
    query,
    subjectKey,
    headline,
    blocks,
    links,
    footer: [
      "Employers can claim exceptions. This is a question for a lawyer; this receipt is the dated proof you bring them.",
      `We have kept every version of this file since ${opts.versionsSince}. The state overwrites it.`,
      ...heldLines(opts),
    ],
  };
}

/** "3 class C, 5 class B" — the city's scale, worst first. */
export function classMix(stamps: { hazardClass: string }[]): string {
  const counts = new Map<string, number>();
  for (const s of stamps) if (s.hazardClass) counts.set(s.hazardClass, (counts.get(s.hazardClass) ?? 0) + 1);
  return ["C", "B", "A"]
    .filter((c) => counts.has(c))
    .map((c) => `${counts.get(c)} class ${c}`)
    .join(", ");
}

const STAMPED = new Set(["FALSE CERTIFICATION", "INVALID CERTIFICATION"]);
const CLASS_RANK: Record<string, number> = { C: 0, B: 1, A: 2 };

export function buildingReceipt(query: string, subjectKey: string, label: string, stamps: BuildingStamp[], opts: ReceiptOpts): Receipt {
  const stamped = stamps.filter((s) => STAMPED.has(s.status));
  const n = stamps.length;
  // A building with twelve live violations is not "no stamps". Count what the
  // city holds, by the city's own scale, and say when it stamped an owner's
  // "it's fixed" as false.
  const mix = classMix(stamps);
  const headline =
    n === 0
      ? `${label} — no violations in the records we hold.`
      : `${label} — ${n} ${n === 1 ? "violation" : "violations"} on record${mix ? ` (${mix})` : ""}${
          stamped.length > 0 ? `; ${stamped.length} stamped ${stamped.length === 1 ? stamped[0].status : "FALSE or INVALID CERTIFICATION"}` : ""
        }.`;
  // The stamps first, then the most hazardous open ones, each in the city's words.
  const shown = [
    ...stamped,
    ...stamps.filter((s) => !STAMPED.has(s.status)).sort((a, b) => (CLASS_RANK[a.hazardClass] ?? 3) - (CLASS_RANK[b.hazardClass] ?? 3) || (a.date < b.date ? 1 : -1)),
  ].slice(0, 6);
  const blocks = shown.map((s) => {
    const head = `${s.status} on ${s.date}${s.hazardClass ? ` (class ${s.hazardClass})` : ""}${s.certifiedBy ? ` — the owner had certified it corrected by ${s.certifiedBy}.` : "."}`;
    return s.description ? [head, s.description.length > 220 ? `${s.description.slice(0, 217).trimEnd()}…` : s.description] : [head];
  });
  if (n > shown.length) blocks.push([`…and ${n - shown.length} more on the building's page.`]);
  return {
    kind: "building",
    query,
    subjectKey,
    headline,
    blocks,
    links: [
      { label: "Check it on the city's page", url: "https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5" },
      ...(opts.pageUrl ? [{ label: "This building's page", url: opts.pageUrl }] : []),
    ],
    footer: [
      "Class C is immediately hazardous, B is hazardous, A is non-hazardous — the city's own scale.",
      `The city may correct a record after we read it. We keep every version, dated, since ${opts.versionsSince}.`,
      ...heldLines(opts),
    ],
  };
}

/**
 * "Nothing filed" is an answer too — the one workers wait months for and every
 * tracker gives as "no results". Dated, with each file's last read, and it
 * can be followed: reply FOLLOW and we say the moment a notice appears.
 */
export function noMatchReceipt(query: string, suggestions: string[], opts?: { provenance?: ReceiptOpts["provenance"]; followKey?: string; at?: number }): Receipt {
  // A whole pasted paragraph echoed back in quotes reads as mockery.
  const shown = query.length > 60 ? `${query.slice(0, 57).trimEnd()}…` : query;
  const at = opts?.at ?? Date.now();
  const files = opts?.provenance ?? [];
  const blocks: string[][] = [];
  if (suggestions.length > 0) blocks.push(["Did you mean:", ...suggestions.map((s) => `— ${s}`)]);
  if (files.length > 0) {
    blocks.push([
      `As of ${stamp(at)}, "${shown}" appears in none of the files we hold. Each was last read:`,
      ...files.map((p) => `— ${p.publisher}: ${stamp(p.lastChecked)} (${p.rows.toLocaleString()} rows${p.coverage ? `, ${p.coverage}` : ""})`),
    ]);
    blocks.push(["Every read is kept as a dated, hashed copy, so this absence is itself on the record.", "Reply FOLLOW and we'll email you if a notice under this name appears in any of them."]);
  } else {
    blocks.push(["Try the company's legal name as it appears on your paperwork, or a street address with the house number."]);
  }
  return {
    kind: "none",
    query,
    subjectKey: opts?.followKey,
    headline: `We couldn't find "${shown}" in the layoff files we hold, or in New York City's housing records.`,
    blocks,
    links: [],
    footer: [
      // What we hold is each state's published file, not the whole history of
      // every notice ever filed: most of these files carry one year, and
      // California's is a rolling window that drops its own oldest rows. On
      // the one receipt whose entire value is a negative, the scope of that
      // negative has to be exact.
      "Each state publishes a file and we keep every version of it. Most carry the current year only, and California's is a rolling window, so a notice older than the window above was never in the file we read — that is not the same as nothing having been filed.",
    ],
  };
}

/**
 * The lines at the bottom of everything we send: who we are, why this arrived,
 * and how to stop it. When we hold a postal address it goes here. When we do
 * not, the line says something true instead of trailing off — an address we do
 * not have is not one we may print, and a made-up one is the very thing the
 * rule exists to prevent.
 */
export function complianceLines(postal: string | undefined, why: string): string[] {
  const trimmed = (postal ?? "").trim();
  return [trimmed ? `Notice · ${trimmed}` : `Notice · ${why}`, "Reply STOP and we will not email you again."];
}

// ---- rendering -------------------------------------------------------------

const HOW_TO = [
  "Reply FOLLOW and we'll email you if this filing changes.",
  "Reply with another company name, or a building address, for another receipt.",
];

/**
 * Someone who has just said STOP is not invited to reply FOLLOW, and the last
 * line they read should be the one that tells them it is over.
 */
const howTo = (r: Receipt) => {
  if (r.query === "stop") return [];
  // "Reply FOLLOW and we'll email you if this filing changes" needs a filing;
  // the nothing-filed receipt carries its own FOLLOW line, worded for absence.
  return r.subjectKey && r.kind !== "none" ? HOW_TO : HOW_TO.slice(1);
};

export function receiptText(r: Receipt): string {
  const parts = [r.headline, ""];
  for (const b of r.blocks) parts.push(...b, "");
  for (const l of r.links) parts.push(`${l.label}: ${l.url}`);
  if (r.links.length) parts.push("");
  parts.push(...howTo(r), "", ...r.footer);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function receiptHtml(r: Receipt): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = r.blocks.map((b) => `<p>${b.map(esc).join("<br>")}</p>`).join("");
  const links = r.links.map((l) => `<p><a href="${l.url}">${esc(l.label)} →</a></p>`).join("");
  const footer = r.footer.map((f) => `<p style="color:#666;font-size:14px">${esc(f)}</p>`).join("");
  const how = HOW_TO.map((h) => `<p style="color:#666;font-size:14px">${esc(h)}</p>`).join("");
  return `<div style="font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1b1b;max-width:640px"><p><strong>${esc(r.headline)}</strong></p>${blocks}${links}${footer}<hr style="border:0;border-top:1px solid #e4e0d8">${how}</div>`;
}
