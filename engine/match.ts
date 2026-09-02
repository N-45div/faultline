import { foldString } from "./canon";

// Deterministic matching of what a person typed to the subjects we hold.
// A model only gets involved later, and only when this says "not sure".

const LEGAL = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
  "plc", "lp", "llp", "holdings", "group", "the", "of", "and", "dba",
]);

export function companyTokens(s: string): string[] {
  return foldString(s)
    .replace(/\bd\s*\/\s*b\s*\/\s*a\b/g, " dba ")
    .replace(/['’]/g, "")
    .replace(/[.,"()&/\\-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t));
}

/**
 * What we hand the full-text index. The index splits "Martin's" into "martin"
 * and "s", so the query must too, or the state's own spelling never comes
 * back. A possessive typed without its apostrophe ("McDonalds") gets its stem
 * beside it. Recall only: ranking still scores the raw query against the raw
 * label.
 */
export function searchTerms(q: string): string {
  const out = new Set<string>();
  for (const t of companyTokens(q.replace(/['’]/g, " "))) {
    out.add(t);
    if (t.length > 3 && t.endsWith("s")) out.add(t.slice(0, -1));
  }
  return [...out].join(" ");
}

export interface Candidate<T> {
  item: T;
  score: number;
}

/** 0..1. Token overlap, with a bonus when every query token is present or the query is a prefix. */
export function scoreCompany(query: string, label: string): number {
  const q = companyTokens(query);
  const l = companyTokens(label);
  if (q.length === 0 || l.length === 0) return 0;
  const qs = new Set(q);
  const ls = new Set(l);
  let inter = 0;
  for (const t of qs) if (ls.has(t)) inter++;
  if (inter === 0) return 0;
  const jaccard = inter / (qs.size + ls.size - inter);
  let s = jaccard;
  if (inter === qs.size) s = Math.max(s, 0.6 + 0.4 * (qs.size / ls.size));
  if (l.slice(0, q.length).join(" ") === q.join(" ")) s = Math.max(s, 0.85);
  return Math.min(1, s);
}

export function rankCompanies<T>(query: string, items: T[], labelOf: (t: T) => string, min = 0.5): Candidate<T>[] {
  return items
    .map((item) => ({ item, score: scoreCompany(query, labelOf(item)) }))
    .filter((c) => c.score >= min)
    .sort((a, b) => b.score - a.score);
}

/** Does this text mention the company? Every company token must appear. */
export function mentionsCompany(text: string, label: string): boolean {
  const tokens = new Set(foldString(text).replace(/[^a-z0-9\s]+/g, " ").split(/\s+/));
  const l = companyTokens(label);
  return l.length > 0 && l.every((t) => tokens.has(t));
}

/**
 * How much of the company's name appears in the text, 0..1. Zero unless at
 * least two tokens hit, or the name is a single distinctive word — so a letter
 * that says "USIC Locating Services" still finds "USIC Locating Services, LLC
 * d/b/a Reconn Utility Services".
 */
export function companyMentionScore(text: string, label: string): number {
  const tokens = new Set(foldString(text).replace(/[^a-z0-9\s]+/g, " ").split(/\s+/));
  const l = [...new Set(companyTokens(label))];
  if (l.length === 0) return 0;
  const hits = l.filter((t) => tokens.has(t));
  if (hits.length === 0) return 0;
  if (hits.length === 1 && (l.length > 1 || hits[0].length < 5)) return 0;
  return hits.length / l.length;
}

// ---- addresses -------------------------------------------------------------

const ABBR: Record<string, string> = {
  ave: "avenue", av: "avenue", st: "street", blvd: "boulevard", rd: "road", pl: "place",
  dr: "drive", ln: "lane", ct: "court", ter: "terrace", pkwy: "parkway", hwy: "highway",
  e: "east", w: "west", n: "north", s: "south", apt: "", unit: "", fl: "", floor: "",
};
const BOROS = new Set(["bronx", "brooklyn", "manhattan", "queens", "staten", "island", "ny", "nyc", "new", "york"]);

export function addressTokens(s: string): string[] {
  return foldString(s)
    .replace(/[.,#]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .map((t) => (t in ABBR ? ABBR[t] : t))
    .filter((t) => t && !BOROS.has(t));
}

/** 0..1. The house number must match exactly; the street is token overlap. */
export function scoreAddress(query: string, label: string): number {
  const q = addressTokens(query);
  const l = addressTokens(label);
  if (q.length < 2 || l.length < 2) return 0;
  if (!/^\d+[a-z]?$/.test(q[0]) || q[0] !== l[0]) return 0;
  const qs = new Set(q.slice(1));
  const ls = new Set(l.slice(1));
  let inter = 0;
  for (const t of qs) if (ls.has(t)) inter++;
  if (inter === 0) return 0;
  return 0.5 + 0.5 * (inter / (qs.size + ls.size - inter));
}

export function rankAddresses<T>(query: string, items: T[], labelOf: (t: T) => string, min = 0.6): Candidate<T>[] {
  return items
    .map((item) => ({ item, score: scoreAddress(query, labelOf(item)) }))
    .filter((c) => c.score >= min)
    .sort((a, b) => b.score - a.score);
}

export function looksLikeAddress(s: string): boolean {
  return /^\s*\d+[a-z]?\s+\S+/i.test(s);
}
