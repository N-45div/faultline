// HPD Online, the city's own website for a building's record, read the way a
// tenant would read it: the building's violations page, the repair's number
// typed into the page's own search box, and its row opened. The site is an
// Angular app; a plain request gets an empty shell, so Firecrawl drives a
// browser through these steps (convex/cityPageCapture.ts) and hands back the
// page as markdown.
//
// Pure: the address, the steps and the reading of the markdown. Nothing here
// fetches. The page's words are kept as the page has them; a status and a
// date are quoted, never translated into the data file's words.

/** Where the site lives. Every building page is under it. */
export const HPD_ONLINE = "https://hpdonline.nyc.gov/hpdonline";

export const isBuildingId = (s: string) => /^\d{1,10}$/.test(s);
export const isViolationId = (s: string) => /^\d{5,10}$/.test(s);

/** The building's violations page. Throws on anything but digits: the address is ours, never a visitor's. */
export function violationsPage(buildingId: string): string {
  if (!isBuildingId(buildingId)) throw new Error(`not a building id: ${buildingId}`);
  return `${HPD_ONLINE}/building/${buildingId}/violations`;
}

/**
 * The building id the city's data file gives a violation
 * (wvxf-dwi5, $select=buildingid): digits, or null for anything else.
 */
export function buildingIdOf(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const id = String((rows[0] as { buildingid?: unknown })?.buildingid ?? "").trim();
  return isBuildingId(id) ? id : null;
}

/**
 * The browser steps, as they ran on 22 September 2026 against #19105968 at
 * building 327072 (10.6 s, one credit, "Showing 1 of 1 result"): wait for the
 * table, open the page's search, type the number into the input for it, press
 * Enter, wait, and open the row whose cell is that number. Each script returns
 * a line saying what it found, so a step that missed says so in the log.
 * Throws on anything but digits: the number is written into the scripts.
 */
export function searchSteps(violationId: string): Array<Record<string, unknown>> {
  if (!isViolationId(violationId)) throw new Error(`not a violation number: ${violationId}`);
  const openSearch =
    "(function(){var b=[].slice.call(document.querySelectorAll('button,a,span,div')).filter(function(e){return (e.innerText||'').trim()==='Search'&&e.offsetParent});" +
    "if(!b.length)return 'no search button';b[b.length-1].click();return 'opened search ('+b.length+')'})()";
  const typeNumber =
    "(function(){var ins=[].slice.call(document.querySelectorAll('input')).filter(function(i){return i.offsetParent&&i.type!=='hidden'});" +
    "var i=ins.find(function(x){return /search/i.test((x.placeholder||'')+(x.getAttribute('aria-label')||'')+(x.id||'')+(x.className||''))&&!/address/i.test(x.placeholder||'')})||ins[ins.length-1];" +
    `if(!i)return 'no input';i.focus();i.value='${violationId}';i.dispatchEvent(new Event('input',{bubbles:true}));` +
    "return 'typed into '+(i.placeholder||i.id||i.className)+' of '+ins.length})()";
  const openRow =
    `(function(){var rows=document.querySelectorAll('table tbody tr');var td=[].slice.call(document.querySelectorAll('td')).find(function(e){return (e.innerText||'').trim()==='${violationId}'});` +
    "if(!td)return 'not found among '+rows.length;var tr=td.closest('tr');var btn=tr.querySelector('button');if(btn)btn.click();return 'rows '+rows.length})()";
  return [
    { type: "wait", selector: "table tbody tr" },
    { type: "executeJavascript", script: openSearch },
    { type: "wait", milliseconds: 800 },
    { type: "executeJavascript", script: typeNumber },
    { type: "press", key: "Enter" },
    { type: "wait", milliseconds: 4000 },
    { type: "executeJavascript", script: openRow },
    { type: "wait", milliseconds: 2000 },
  ];
}

/** What the page says about one repair, in its own words. */
export type HpdOnlineRow = {
  /** VIOLATION STATUS, as the page prints it: "CIV10 MAILED". */
  statusText: string;
  /** VIOLATION STATUS DATE, as printed: "08/18/2026". */
  statusDate: string | null;
  /** ACTUAL CERT. DATE, the day the owner certified it: "08/12/2026". */
  certDate: string | null;
};

export type HpdOnlineRead =
  | ({ kind: "found" } & HpdOnlineRow)
  /** The page answered and does not list it: its list is open violations only. */
  | { kind: "not_found" }
  /** Read, but not in a shape that says either: the search or the row did not open, or it is not the page. */
  | { kind: "unreadable"; why: string };

/** The labels of an opened row, in the order the page prints them. */
const LABELS = ["NOV ISSUED DATE", "NOV ID", "NOV TYPE", "CORRECTION BY DATE", "CERTIFICATION BY DATE", "ACTUAL CERT. DATE", "VIOLATION STATUS", "VIOLATION STATUS DATE"];

// The site's own sentences (its shared English strings): a search that found
// nothing, a building with no open violations, and the site failing to answer.
const NOT_LISTED = [/No violations were retrieved\./i, /There are no open violations for this building/i, /\bShowing 0 of\b/i];
const CITY_ERROR = /Something went wrong\. We couldn't get this information/i;

const label = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
/** Markdown's backslash escapes, taken off, so the page's words are quoted as it has them. */
const plain = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1").replace(/\s+/g, " ").trim();
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** The value printed under a label in an opened row; null when it is missing, blank or a dash. */
function under(parts: string[], name: string): string | null {
  const at = parts.findIndex((p) => label(p) === name);
  if (at < 0) return null;
  const value = plain(parts[at + 1] ?? "");
  if (!value || value === "-" || LABELS.includes(label(value))) return null;
  return value.slice(0, 80);
}

/**
 * The repair's row on the violations page, from Firecrawl's markdown of it.
 * Found when the table lists the number and its opened row prints a
 * VIOLATION STATUS; not found when the page says it retrieved nothing; anything
 * else is unreadable, with why.
 */
export function readHpdOnline(markdown: string, violationId: string): HpdOnlineRead {
  const lines = (markdown ?? "").replace(/\r/g, "").split("\n");
  const at = lines.findIndex((l) => l.trim().startsWith("|") && !/<br\s*\/?>/i.test(l) && cells(l).includes(violationId));
  if (at >= 0) {
    // The opened row is the next line of the table with the labels in it,
    // before the next repair's own line.
    for (let i = at + 1; i < lines.length && lines[i].trim().startsWith("|"); i++) {
      if (!/<br\s*\/?>/i.test(lines[i])) break;
      const cell = cells(lines[i]).find((c) => /VIOLATION STATUS/i.test(c));
      if (!cell) continue;
      const parts = cell.split(/<br\s*\/?>/i).map((p) => p.trim());
      const statusText = under(parts, "VIOLATION STATUS");
      if (!statusText) return { kind: "unreadable", why: "the repair's row was opened but prints no status" };
      return { kind: "found", statusText, statusDate: under(parts, "VIOLATION STATUS DATE"), certDate: under(parts, "ACTUAL CERT. DATE") };
    }
    return { kind: "unreadable", why: "the repair is listed, but its row did not open" };
  }
  if (CITY_ERROR.test(markdown)) return { kind: "unreadable", why: "HPD Online said something went wrong" };
  if (NOT_LISTED.some((r) => r.test(markdown))) return { kind: "not_found" };
  if (/\|\s*VIOLATION ID\s*\|/i.test(markdown)) return { kind: "unreadable", why: "the search did not narrow the list to this repair" };
  return { kind: "unreadable", why: "the page was not the building's violations" };
}
