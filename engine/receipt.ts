import { warnNoticeGap } from "./rules";

// The receipt is the product. Every word here is read by someone who got a
// letter this month, so it uses the record's own words and never a verdict.

export interface LayoffNoticeRow {
  company: string;
  siteAddress: string;
  workers: number;
  noticeDate: string;
  effectiveDate: string;
  postedDate: string;
  jurisdiction: "US-NY" | "US-CA";
  layoffOrClosure?: string;
  reason?: string;
}

export interface BuildingStamp {
  status: string;
  date: string;
  hazardClass: string;
  certifiedBy: string | null;
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
}

const STATE = { "US-NY": "New York", "US-CA": "California" } as const;
const STATE_PAGE = {
  "US-NY": "https://dol.ny.gov/warn-notices",
  "US-CA": "https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN/",
} as const;

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export function layoffReceipt(query: string, subjectKey: string, rows: LayoffNoticeRow[], opts: ReceiptOpts): Receipt {
  const scored = rows
    .map((r) => ({ r, g: warnNoticeGap({ jurisdiction: r.jurisdiction, noticeDate: r.noticeDate, effectiveDate: r.effectiveDate, postedDate: r.postedDate || undefined }) }))
    .sort((a, b) => a.g.actualDays - b.g.actualDays || b.r.workers - a.r.workers);

  const first = scored[0];
  const totalWorkers = rows.reduce((n, r) => n + r.workers, 0);
  const sites = new Set(rows.map((r) => r.siteAddress)).size;
  const headline =
    sites > 1
      ? `${first.r.company} — ${sites} sites, ${totalWorkers} workers in ${STATE[first.r.jurisdiction]}'s layoff file.`
      : `${first.r.company} — ${first.r.siteAddress}. ${first.r.workers} workers.`;

  const blocks = scored.slice(0, 5).map(({ r, g }) => {
    const state = STATE[r.jurisdiction];
    const event = r.layoffOrClosure?.toLowerCase().includes("closure") ? "closure" : "layoff";
    const kind = [r.layoffOrClosure, r.reason].filter(Boolean).join(" · ");
    const siteLine = sites > 1 ? `${r.siteAddress} — ${r.workers} workers${kind ? ` · ${kind}` : ""}` : kind;
    const noticeLine =
      g.verdict === "gap"
        ? `${days(g.actualDays)}' notice. ${state}'s WARN Act sets ${g.statutoryDays}.`
        : `${days(g.actualDays)}' notice — inside the ${g.statutoryDays} ${state} sets.`;
    const lines = [siteLine, `Notice dated ${r.noticeDate}. ${event === "closure" ? "Closure" : "Layoff"} started ${r.effectiveDate}.`, noticeLine];
    if (g.postingLagDays !== null) {
      const posted = `${state} put this online on ${r.postedDate}, ${days(g.postingLagDays)} after the notice`;
      lines.push(g.postedAfterEffective ? `${posted} — after the ${event} had started.` : `${posted}.`);
    }
    return lines.filter(Boolean);
  });
  if (scored.length > 5) blocks.push([`…and ${scored.length - 5} more sites.`]);

  const links: Receipt["links"] = [{ label: `Check it on the state's page`, url: STATE_PAGE[first.r.jurisdiction] }];
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
    ],
  };
}

export function buildingReceipt(query: string, subjectKey: string, label: string, stamps: BuildingStamp[], opts: ReceiptOpts): Receipt {
  const stamped = stamps.filter((s) => s.status === "FALSE CERTIFICATION" || s.status === "INVALID CERTIFICATION");
  const headline =
    stamped.length > 0
      ? `${label} — HPD has stamped ${stamped.length} ${stamped.length === 1 ? "violation" : "violations"} ${stamped.length === 1 ? stamped[0].status : "FALSE or INVALID CERTIFICATION"}.`
      : `${label} — no certification stamps in the records we hold.`;
  const blocks = stamped.slice(0, 8).map((s) => [
    `${s.status} on ${s.date}${s.hazardClass ? ` (class ${s.hazardClass})` : ""}${s.certifiedBy ? ` — the owner had certified it corrected by ${s.certifiedBy}.` : "."}`,
  ]);
  if (stamped.length > 8) blocks.push([`…and ${stamped.length - 8} more.`]);
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
    ],
  };
}

export function noMatchReceipt(query: string, suggestions: string[]): Receipt {
  return {
    kind: "none",
    query,
    headline: `We couldn't find "${query}" in New York's or California's layoff files, or in New York City's housing records.`,
    blocks: [
      suggestions.length > 0
        ? ["Did you mean:", ...suggestions.map((s) => `— ${s}`)]
        : ["Try the company's legal name as it appears on your paperwork, or a street address with the house number."],
    ],
    links: [],
    footer: ["We hold every layoff notice New York and California have published, and the violations for 300 New York City buildings."],
  };
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
const howTo = (r: Receipt) => (r.query === "stop" ? [] : HOW_TO);

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
