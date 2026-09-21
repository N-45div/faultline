import { askHeadline, fixedClaim } from "./hpd";

// The ASK reply, read back into its repairs, for the page that shows it. Each
// line it reads was written by askLine (engine/hpd.ts) and put into the reply
// as "- " + askLine(...) by askReceiptFor (convex/inbound.ts); this is that
// line run backwards. It decides nothing: if a single line does not read back,
// none is used, and the reply shows as the plain text it is.
//
// Imported by the page and the checks only. The server never reads it.

export type AskRow = {
  /** HPD's violation number, the one an answer names. */
  id: string;
  /** HPD's hazard class, when the row had one. */
  cls: string | null;
  /** The thing that needed repair, in a few plain words, when the city's text names one. */
  thing: string | null;
  /** The city's own description, as the reply quoted it (it may end in an ellipsis). */
  cityWords: string;
  /** HPD's status, verbatim. */
  status: string;
  /** The day of that status, YYYY-MM-DD. */
  asOf: string;
  /** The last of HPD's 70 days, for an owner's certification. */
  until: string | null;
  /** The line exactly as askLine wrote it, without the "- " the reply puts before it. */
  line: string;
};

const OWNER = "The owner certified this corrected";
const CITY = "The city closed this";

/**
 * askLine, backwards:
 *   #{id} at {where}[ (class {c})][ — "{description}"]. {who}: {status} as of {date}[; the owner had certified it corrected on {date}].[ HPD's 70 days run to {date}.]
 * The description is greedy on purpose: it is the one part that may itself hold
 * quotation marks, and whatever follows it is fixed words and dates.
 */
const ROW = new RegExp(
  [
    "^- #(\\d{5,10}) at (.+?)",
    "(?: \\(class ([^()]+)\\))?",
    '(?: — "(.*)")?',
    `\\. (${OWNER}|${CITY}): (.+?) as of (\\d{4}-\\d{2}-\\d{2})(?:T[\\d:.]+Z?)?`,
    "(?:; the owner had certified it corrected on ([^\\s;]+))?",
    "\\.(?: HPD's 70 days run to (\\d{4}-\\d{2}-\\d{2})\\.)?$",
  ].join(""),
);

function isAskHeadline(first: string): boolean {
  if (first === askHeadline(1)) return true;
  const n = /^They say (\d{1,3}) things are fixed\. Are they\?$/.exec(first)?.[1];
  return n !== undefined && first === askHeadline(Number(n));
}

/**
 * The repairs an ASK reply lists, one row each. Any other reply, or an ASK
 * reply with a line that does not read back exactly, gives [].
 */
export function askRows(reply: string): AskRow[] {
  const lines = (reply ?? "").split(/\r?\n/);
  if (!isAskHeadline(lines[0]?.trim() ?? "")) return [];
  const rows: AskRow[] = [];
  for (const raw of lines) {
    if (!raw.startsWith("- #")) continue;
    const m = ROW.exec(raw);
    if (!m) return [];
    const [, id, , cls, described, who, status, asOf, certifiedBy, until] = m;
    // askLine picks its words from the status, so the two must agree; the
    // owner's earlier date is only written for a closure, the 70 days only
    // for a certification.
    const owner = fixedClaim(status) === "owner";
    if ((who === OWNER) !== owner) return [];
    if (certifiedBy !== undefined && owner) return [];
    if (until !== undefined && !owner) return [];
    const cityWords = described ?? "";
    rows.push({
      id,
      cls: cls ?? null,
      thing: cityWords ? plainThing(cityWords) : null,
      cityWords,
      status,
      asOf,
      until: until ?? null,
      line: raw.slice(2),
    });
  }
  return rows;
}

// Where the name of the thing stops in HPD's text: at where it is, at what is
// to be done to it next, at a word for its state ("PLEXIGLASS INSTALLED AT",
// "DEVICE MISSING IN"), which would read as the work done, or at the end of a
// clause.
const END = "(?= AT | IN | ON | AND PAINT| AND MAINTAIN| (?:INSTALLED|MISSING|PRESENT)(?![A-Z])|[,.;:]|$)";
const THINGS = [
  `EVIDENCE OF (?:AN? )?([A-Z /-]+?)${END}`,
  `BROKEN OR DEFECTIVE ([A-Z /-]+?)${END}`,
  `ACCUMULATION OF ([A-Z /-]+?)${END}`,
  `NUISANCE CONSISTING OF ([A-Z /-]+?)${END}`,
  `INFESTATION CONSISTING OF ([A-Z /-]+?)${END}`,
].map((p) => new RegExp(p));

/**
 * The thing in the city's description, as a tenant would name it: "BROKEN OR
 * DEFECTIVE VINYL FLOOR TILES IN THE KITCHEN" is "Vinyl floor tiles". One to
 * five words, or null when HPD's text names nothing that plainly.
 */
export function plainThing(desc: string): string | null {
  const flat = (desc ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const cut = flat.endsWith("…");
  const d = flat.replace(/…/g, "").trimEnd();
  for (const re of THINGS) {
    const m = re.exec(d);
    if (!m) continue;
    // Where the reply cut the description short, it may have cut the thing too.
    if (cut && m.index + m[0].length >= d.length) continue;
    const words = m[1].trim().toLowerCase().split(" ").filter(Boolean);
    if (words.length < 1 || words.length > 5) continue;
    const said = words.join(" ");
    return said[0].toUpperCase() + said.slice(1);
  }
  return null;
}
