import { noticePhrase, warnNoticeGap } from "./rules";

// The receipt is the product. Every word here is read by someone who got a
// letter this month, so it uses the record's own words and never a verdict.

export interface LayoffNoticeRow {
  company: string;
  siteAddress: string;
  workers: number;
  noticeDate: string;
  effectiveDate: string;
  postedDate: string;
  jurisdiction: "US-NY" | "US-CA" | "US-MD" | "US-CO" | "US-NC" | "US-VA";
  layoffOrClosure?: string;
  reason?: string;
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
  provenance?: { publisher: string; url: string; at: number; status: number; rows: number; lastChecked: number }[];
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
  if (opts.held && opts.held.rows > 0 && opts.held.since) {
    const h = opts.held;
    out.push(
      `We hold ${h.rows} ${h.rows === 1 ? "row" : "rows"} for this, in ${h.versions} ${h.versions === 1 ? "version" : "versions"}, and have read the file ${h.reads} ${h.reads === 1 ? "time" : "times"} since ${stamp(h.since).slice(0, 10)}.`,
    );
  }
  for (const p of opts.provenance ?? []) {
    out.push(`Read from ${p.publisher}'s file on ${stamp(p.at)} (HTTP ${p.status}, ${p.rows.toLocaleString()} rows); last checked ${stamp(p.lastChecked)}. ${p.url}`);
  }
  return out;
}

const STATE = { "US-NY": "New York", "US-CA": "California", "US-MD": "Maryland", "US-CO": "Colorado", "US-NC": "North Carolina", "US-VA": "Virginia" } as const;
const STATE_PAGE = {
  "US-NY": "https://dol.ny.gov/warn-notices",
  "US-CA": "https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN/",
  "US-MD": "https://labor.maryland.gov/employment/warn.shtml",
  "US-CO": "https://cdle.colorado.gov/employers/layoff-separations/layoff-warn-list",
  "US-NC": "https://www.commerce.nc.gov/data-tools-reports/labor-market-data-tools/workforce-warn-reports/report-workforce-warn-summary-list-2026",
  "US-VA": "https://virginiaworks.gov/im-an-employer/retain-and-grow/warn-notices/",
} as const;

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export function layoffReceipt(query: string, subjectKey: string, rows: LayoffNoticeRow[], opts: ReceiptOpts): Receipt {
  const scored = rows
    .map((r) => ({ r, g: warnNoticeGap({ jurisdiction: r.jurisdiction, noticeDate: r.noticeDate, effectiveDate: r.effectiveDate, postedDate: r.postedDate || undefined }) }))
    .sort((a, b) => a.g.actualDays - b.g.actualDays || b.r.workers - a.r.workers);

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
  const years = rows.map((r) => r.noticeDate.slice(0, 4)).filter(Boolean).sort();
  const span = years.length > 1 && years[0] !== years.at(-1) ? `, ${years[0]}–${years.at(-1)}` : "";
  const headline =
    filings > 1
      ? `${first.r.company} — ${filings} filings in ${stateList}, ${totalWorkers} workers${span}.`
      : `${first.r.company} — ${first.r.siteAddress}. ${first.r.workers} ${first.r.workers === 1 ? "worker" : "workers"}.`;

  const blocks = scored.slice(0, 5).map(({ r, g }) => {
    const state = STATE[r.jurisdiction];
    const event = r.layoffOrClosure?.toLowerCase().includes("closure") ? "closure" : "layoff";
    const kind = [r.layoffOrClosure, r.reason].filter(Boolean).join(" · ");
    const people = `${r.workers} ${r.workers === 1 ? "worker" : "workers"}`;
    const siteLine =
      filings > 1
        ? `${states.length > 1 ? `${state} · ` : ""}${r.siteAddress} — ${people}${kind ? ` · ${kind}` : ""}`
        : kind;
    const phrase = noticePhrase(g.actualDays);
    const noticeLine =
      g.verdict === "gap"
        ? `${phrase[0].toUpperCase()}${phrase.slice(1)}. ${state}'s WARN Act sets ${g.statutoryDays} days.`
        : `${phrase[0].toUpperCase()}${phrase.slice(1)} — inside the ${g.statutoryDays} days ${state} sets.`;
    const lines = [siteLine, `Notice dated ${r.noticeDate}. ${event === "closure" ? "Closure" : "Layoff"} started ${r.effectiveDate}.`, noticeLine];
    if (g.postingLagDays !== null) {
      const posted = `${state} put this online on ${r.postedDate}, ${days(g.postingLagDays)} after the notice`;
      lines.push(g.postedAfterEffective ? `${posted} — after the ${event} had started.` : `${posted}.`);
    }
    return lines.filter(Boolean);
  });
  if (scored.length > 5) blocks.push([`…and ${scored.length - 5} more filings.`]);

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

export function noMatchReceipt(query: string, suggestions: string[]): Receipt {
  return {
    kind: "none",
    query,
    // A whole pasted paragraph echoed back in quotes reads as mockery.
    headline: `We couldn't find "${query.length > 60 ? `${query.slice(0, 57).trimEnd()}…` : query}" in the layoff files we hold, or in New York City's housing records.`,
    blocks: [
      suggestions.length > 0
        ? ["Did you mean:", ...suggestions.map((s) => `— ${s}`)]
        : ["Try the company's legal name as it appears on your paperwork, or a street address with the house number."],
    ],
    links: [],
    footer: ["We hold every layoff notice New York, California, Virginia, Maryland, Colorado and North Carolina have published, and the housing records for hundreds of New York City buildings."],
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
  // "Reply FOLLOW and we'll email you if this filing changes" needs a filing.
  return r.subjectKey ? HOW_TO : HOW_TO.slice(1);
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
