import type { Fields } from "./types";

// The city's own status vocabulary for a housing violation, and the three
// moments the tenant loop turns on: the owner says it's fixed, the city closes
// it, and the city later says the owner's word was false. The words below are
// HPD's, verbatim from its file; nothing here is a verdict of ours.

/** The owner certified the violation corrected — HPD's two stamps for it. */
export const OWNER_SAYS_FIXED = new Set(["NOV CERTIFIED ON TIME", "NOV CERTIFIED LATE"]);
/** The city closed the violation. */
export const CITY_CLOSED = new Set(["VIOLATION CLOSED"]);
/** The city checked the owner's certification and found it false or invalid. */
export const CITY_SAYS_FALSE = new Set(["FALSE CERTIFICATION", "INVALID CERTIFICATION"]);

export type FixedClaim = "owner" | "city";

/** Does this status say the repair was made — and whose word is it? */
export function fixedClaim(status: string): FixedClaim | null {
  const s = (status ?? "").trim().toUpperCase();
  if (OWNER_SAYS_FIXED.has(s)) return "owner";
  if (CITY_CLOSED.has(s)) return "city";
  return null;
}

export function saysFalse(status: string): boolean {
  return CITY_SAYS_FALSE.has((status ?? "").trim().toUpperCase());
}

export interface Ask {
  violationId: string;
  status: string;
  statusDate: string;
  certifiedBy: string | null;
  hazardClass: string;
  description: string;
}

/** The question, from the row's own fields. Null when the row makes no fixed claim. */
export function askFrom(after: Fields): Ask | null {
  const status = String(after.currentstatus ?? "");
  if (!fixedClaim(status)) return null;
  const violationId = String(after.violationid ?? "").trim();
  if (!violationId) return null;
  return {
    violationId,
    status,
    statusDate: String(after.currentstatusdate ?? ""),
    certifiedBy: after.certifiedbydate ? String(after.certifiedbydate) : null,
    hazardClass: String(after.class ?? ""),
    description: String(after.novdescription ?? "")
      .replace(/[\u0000-\u001f]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
  };
}

/** One line of the ask: the city's words, and the number a reply needs. */
export function askLine(a: Ask, where: string): string {
  const who = fixedClaim(a.status) === "owner" ? "The owner certified this corrected" : "The city closed this";
  const cls = a.hazardClass ? ` (class ${a.hazardClass})` : "";
  const what = a.description ? ` — "${shorten(a.description, 120)}"` : "";
  const by = a.certifiedBy && fixedClaim(a.status) === "city" ? `; the owner had certified it corrected by ${a.certifiedBy}` : "";
  const clock = challengeDeadline(a);
  const until = clock ? ` HPD's 70 days run to ${clock}.` : "";
  return `#${a.violationId} at ${where}${cls}${what}. ${who}: ${a.status} as of ${a.statusDate}${by}.${until}`;
}

/**
 * What to do when the owner's word and the tenant's don't agree — HPD's own
 * process, in its own words (nyc.gov/hpd, "Clear Violations" and "Report a
 * Quality or Safety Issue"): tenants are notified of a certification and
 * "may challenge the certification, triggering an audit inspection"; a
 * certified violation HPD does not reinspect "will be closed after 70 days".
 * HPD publishes no form for the challenge; 311 is its front door.
 */
export const HOW_TO_TELL_HPD =
  "HPD says a tenant may challenge the certification, which triggers an audit inspection. It publishes no form for it: call 311 or use nyc.gov/311, give the violation number, and say the certified condition is still there. A certified violation HPD does not reinspect closes after 70 days.";

export const HPD_PAGES = {
  certification: "https://www.nyc.gov/site/hpd/services-and-information/clear-violations.page",
  tenant: "https://www.nyc.gov/site/hpd/services-and-information/report-a-maintenance-issue.page",
  penalties: "https://www.nyc.gov/site/hpd/services-and-information/penalties-and-fees.page",
};

/**
 * A closed violation is the city's word, not the owner's: there is no
 * certification to challenge. HPD says complaints are made through 311, so a
 * condition that is still there after a closure goes back that way.
 */
export const HOW_TO_REPORT_AGAIN =
  "The city closed this violation, so there is no certification to challenge. If the condition is still there, report it again the way HPD takes complaints: call 311 or use nyc.gov/311, and describe it.";

/** HPD's 70 days from the certification, after which an unreinspected violation is deemed complied. */
export function challengeDeadline(a: Ask): string | null {
  if (fixedClaim(a.status) !== "owner") return null;
  const from = a.certifiedBy ?? a.statusDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 70);
  return d.toISOString().slice(0, 10);
}

export type Answer = "fixed" | "still_broken" | "not_sure";

export interface ParsedAnswer {
  answer: Answer;
  violationId: string | null;
  note: string;
}

const STILL_BROKEN =
  /\b(still broken|not fixed|still not fixed|isn'?t fixed|wasn'?t fixed|never (got )?fixed|not repaired|still leaking|still there|still (the )?same|nothing (was |has been )?(done|fixed|repaired)|no[,.!]? (it'?s |it is )?(still|not))\b/i;
const NOT_SURE = /\b(not sure|unsure|don'?t know|do not know|no idea|can'?t tell|haven'?t checked)\b/i;
const FIXED = /\b(fixed(?![- ]?(term|price|rate|cost|fee|income|asset))|repaired|it'?s done|been done|resolved|all good)\b/i;
const ID = /#\s?(\d{5,10})\b/;
/** Past this, it is a letter or a story, not an answer to a yes-or-no question. */
const MAX_ANSWER_CHARS = 400;

/**
 * A reply to "Is it fixed?": the answer, the violation it is about, and what
 * else the person said. Only the lines the person typed count — the quoted
 * text below them is our own question coming back — except for the number,
 * which usually lives only in the quote.
 */
export function parseAnswer(subject: string, body: string): ParsedAnswer | null {
  const own = ownLines(body);
  if (own.length > MAX_ANSWER_CHARS) return null;
  const candidates = [own, cleanAnswerSubject(subject)].filter((s) => s.length > 0);
  let answer: Answer | null = null;
  for (const c of candidates) {
    if (STILL_BROKEN.test(c)) answer = "still_broken";
    else if (NOT_SURE.test(c)) answer = "not_sure";
    else if (FIXED.test(c)) answer = "fixed";
    if (answer) break;
  }
  if (!answer) return null;
  const id = ID.exec(own) ?? ID.exec(body ?? "");
  const note = own
    .replace(/#\s?\d{5,10}/g, "")
    .replace(STILL_BROKEN, "")
    .replace(NOT_SURE, "")
    .replace(FIXED, "")
    .replace(/^[\s,.:;!-]+|[\s,.:;!-]+$/g, "")
    .slice(0, 300);
  return { answer, violationId: id ? id[1] : null, note };
}

/** The lines a person typed, above the quoted reply. */
export function ownLines(body: string): string {
  const lines = (body ?? "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^on .{6,160} wrote:$/i.test(l) || /^-{2,}\s*(original|forwarded) message/i.test(l) || /^from:\s/i.test(l) || /^_{5,}$/.test(l)) break;
    // "-- " is the signature separator; "Sent via …" and "Sent from my …" are signatures without one.
    if (/^-{2,3}$/.test(l) || /^sent (via|from) /i.test(l)) break;
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** Our own subject line comes back on every reply; only what the person added counts. */
function cleanAnswerSubject(s: string): string {
  const cleaned = (s ?? "").replace(/^\s*((re|fwd?|fw|aw|wg)\s*:\s*)+/i, "").trim();
  return /^(a filing you follow changed|filings you follow changed|is it fixed\?)/i.test(cleaned) ? "" : cleaned.slice(0, 200);
}

function shorten(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The next step for a person who says a fixed claim is not true, by whose claim it was. */
export function nextStepFor(status: string): string {
  return fixedClaim(status) === "city" ? HOW_TO_REPORT_AGAIN : HOW_TO_TELL_HPD;
}

/**
 * What to ask about on request: the owner's certifications whose 70 days have
 * not run out, newest first — the ones HPD has not yet closed. A violation the
 * city already closed is not asked about on request.
 */
export function pickAsks(rows: Fields[], today: string, max = 3): Ask[] {
  const asks: Ask[] = [];
  for (const f of rows) {
    const a = askFrom(f);
    if (!a || fixedClaim(a.status) !== "owner") continue;
    const until = challengeDeadline(a);
    if (!until || until < today) continue;
    asks.push(a);
  }
  return asks
    .sort((x, y) => (x.statusDate < y.statusDate ? 1 : x.statusDate > y.statusDate ? -1 : x.violationId.localeCompare(y.violationId)))
    .slice(0, max);
}

/** The city's second word, told to the person who answered first. */
export function secondWordLine(p: { answer: Answer; saidOn: string; violationId: string; where: string; status: string; on: string }): string {
  const said = p.answer === "still_broken" ? "still broken" : p.answer === "fixed" ? "fixed" : "not sure";
  const lead = p.answer === "still_broken" ? "The city agrees with you: " : "";
  return `${lead}HPD stamped #${p.violationId} at ${p.where} ${p.status} on ${p.on}. You said ${said} on ${p.saidOn}; both dates are on your record.`;
}
