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

/**
 * The owner certified, but after the date the notice set for it. A late one is
 * shown no 70-day clock and no close date, and nothing is said in their place.
 * The city's file was read as HPD closing a certification made on time 72 to 75
 * days later and not closing a late one on that clock, but the query that shows
 * it is not kept in this repo, so a tenant is not told it. Leaving a day out
 * claims nothing.
 */
export function certifiedLate(status: string): boolean {
  return (status ?? "").trim().toUpperCase() === "NOV CERTIFIED LATE";
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
  const by = a.certifiedBy && fixedClaim(a.status) === "city" ? `; the owner had certified it corrected on ${a.certifiedBy}` : "";
  const clock = challengeDeadline(a);
  const until = clock ? ` HPD's 70 days run to ${clock}.` : "";
  return `#${a.violationId} at ${where}${cls}${what}. ${who}: ${a.status} as of ${a.statusDate}${by}.${until}`;
}

/** The headline of an ASK reply. */
export function askHeadline(n: number): string {
  return n === 1 ? "They say it's fixed. Is it?" : `They say ${n} things are fixed. Are they?`;
}

/**
 * The two lines under the asks in every ASK reply: how to answer, and where the answer goes. A browser trial's
 * answer is never counted on a public page, so its reply says that instead of how a real answer can reach one.
 */
export function howToAnswer(firstViolationId: string, trial = false): string[] {
  return [
    `Reply with the number and one of FIXED, STILL BROKEN or NOT SURE — for example: #${firstViolationId} STILL BROKEN. Add a photo if you have one. Or just tell us in your own words.`,
    trial
      ? "This is a practice answer: it is kept, dated, on this page and on your record, and it is never counted on the building's public page."
      : "Your answer stays private to you, dated, beside the city's record. It shows on the building's page only if the city's own record later agrees.",
  ];
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

/**
 * HPD's 70 days from the certification, after which an unreinspected violation
 * is deemed complied. Only for a certification made on time: a late one is
 * shown no day (certifiedLate).
 */
export function challengeDeadline(a: Ask): string | null {
  if (fixedClaim(a.status) !== "owner" || certifiedLate(a.status)) return null;
  return seventyDaysFrom(a);
}

/** Seventy days from the day the owner certified (else the status date): the bare arithmetic, whatever the status. */
export function seventyDaysFrom(a: Ask): string | null {
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

/** The line a mail client writes above the reply it quotes: "On Mon, Sep 14, 2026 … wrote:". */
const QUOTE_INTRO = /^on .{6,160} wrote:$/i;

/** The lines a person typed, above the quoted reply. */
export function ownLines(body: string): string {
  const lines = (body ?? "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (QUOTE_INTRO.test(l) || /^-{2,}\s*(original|forwarded) message/i.test(l) || /^from:\s/i.test(l) || /^_{5,}$/.test(l)) break;
    // "-- " is the signature separator; "Sent via …" and "Sent from my …" are signatures without one.
    if (/^-{2,3}$/.test(l) || /^sent (via|from) /i.test(l)) break;
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/**
 * Everything a person wrote in a reply and nothing we did, for a note passed on
 * as theirs: the subject they gave it, as the model is shown it, and their lines
 * above our quoted reply, or, with none above it, the lines they wrote under and
 * between its quoted ones. Our quote and the line that introduces it do not
 * count; a forwarded message or a signature still ends what they wrote.
 */
export function theirWords(subject: string, body: string): string {
  const inline = (body ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !QUOTE_INTRO.test(l.trim()))
    .join("\n");
  return [(subject ?? "").trim(), ownLines(body) || ownLines(inline)].filter(Boolean).join("\n");
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
 * not run out, newest first — the ones HPD has not yet closed. A late one is
 * asked about for the same 70 days, with no clock. A violation the city
 * already closed is not asked about on request.
 */
/** The building the landing page, the tour and the browser trial all start from. */
export const SAMPLE_BBL = "3050840061";

export function pickAsks(rows: Fields[], today: string, max = 3): Ask[] {
  const asks: Ask[] = [];
  for (const f of rows) {
    const a = askFrom(f);
    if (!a || fixedClaim(a.status) !== "owner") continue;
    // The same 70 days for a late certification: it is asked about as long as
    // an on-time one would be, only with no clock on its line.
    const until = seventyDaysFrom(a);
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

// A home, as the city names one before its unit, and the way it finds one on a floor.
const HOME = String.raw`(?:(?:CELLAR|BASEMENT|BSMT)[ -])?(?:APT|B-ROOM)`;
const SIDE = "(?:NORTH|SOUTH|EAST|WEST)";
// The clause runs to the end of the description, or to the city's note that a violation was upgraded.
const TO_END = String.raw`.*?(?=\s+ORIGINAL VIOLATION\b|$)`;
const LOCATED_AT_HOME = new RegExp(String.raw`\s*\bLOCATED AT ${HOME}\b${TO_END}`, "gi");
const STORY_APARTMENT = new RegExp(String.raw`\s*,?\s*\b\d+(?:ST|ND|RD|TH) STORY, APARTMENT\b${TO_END}`, "gi");
// After a floor, whatever follows APT is the unit ("5 STY NORTHEAST APT PH"); after a bare APT only one with a number is.
const UNIT_NAMED = new RegExp(String.raw`\b(?:\d+ S?TY(?: ${SIDE}+){0,2} APT\b\.?\s*(?:NO\.?|#)?\s*|APT\b\.?\s*(?:NO\.?|#)?\s*(?=[A-Z0-9-]*\d))[A-Z0-9][A-Z0-9-]*`, "gi");
// A receipt line cut inside that form ends in part of it, before the unit ("5 STY NORTHEA…").
const upTo = (word: string) => [...word].map((_, i) => word.slice(0, i + 1)).reverse().join("|");
const UNIT_CUT = new RegExp(String.raw`\s*\b\d+ S?TY(?: ${SIDE}+){0,2}(?: ${SIDE}*(?:${["NORTH", "SOUTH", "EAST", "WEST", "APT"].map(upTo).join("|")}))?(?=…$)`, "i");
const PUBLIC_PARTS_UNIT = /\b(LOCATED AT PUBLIC PARTS) (?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]*/gi;
const POSITION = new RegExp(String.raw`\s*,?\s*\b\d+(?:ST|ND|RD|TH) (?:(?:CELLAR|BSMT)[ -])?(?:APARTMENT|APT|B-ROOM) FROM ${SIDE}(?: AT ${SIDE})?`, "gi");

/**
 * The city's description of a violation inside a home ends by saying which
 * home: "LOCATED AT APT 4A, 4th STORY, 1st APARTMENT FROM NORTH AT EAST", with
 * CELLAR APT, BSMT-APT or B-ROOM in place of APT in some buildings, and a
 * SECTION after it in others. The building page shows it as the city publishes
 * it. A link preview is read by whoever the link is pasted to, so there the
 * clause is left out whole: the floor and the position find the same door the
 * unit does. What the condition is, "IN THE ENTIRE APARTMENT", and the city's
 * note after the clause that a violation was upgraded stay the city's words.
 * An older form names the unit with no clause ("5 STY NORTHEAST APT L4"); the
 * unit and the floor in front of it go, whatever the unit is ("APT PH"), and
 * a line cut inside them after the floor loses the part of them it kept
 * ("5 STY NORTHEA…"). "APT. ENTRANCE DOOR", with no floor in front and no
 * number after, names no unit and stays. A public part keeps its place and
 * loses only the unit the city filed it under ("LOCATED AT PUBLIC PARTS 1E,
 * 1st STORY").
 */
export function withoutUnit(text: string): string {
  return (text ?? "")
    .replace(LOCATED_AT_HOME, " [apartment withheld]")
    .replace(STORY_APARTMENT, " [apartment withheld]")
    .replace(UNIT_NAMED, "APT [unit]")
    .replace(UNIT_CUT, "")
    .replace(PUBLIC_PARTS_UNIT, "$1")
    .replace(POSITION, "")
    .trim();
}
