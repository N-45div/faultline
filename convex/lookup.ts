import { v } from "convex/values";
import { query } from "./_generated/server";
import type { DatabaseReader } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { addressTokens, companyMentionScore, companyTokens, looksLikeAddress, rankAddresses, rankCompanies, sameCompany, searchTerms } from "../engine/match";
import { foldString, slug, urlSlug } from "../engine/canon";
import { layoffCsv } from "../engine/export";
import {
  buildingReceipt,
  layoffReceipt,
  noMatchReceipt,
  type BuildingStamp,
  type RestaurantRow,
  type LayoffNoticeRow,
  type Receipt,
  type ReceiptOpts,
} from "../engine/receipt";

/** What versionsFor returns. Named, so the query's type cannot chase its own tail. */
export interface Held {
  rows: { identityKey: string; label: string; firstSeen: number; lastSeen: number; versions: number; hash: string }[];
  changes: { at: number; sentence: string; kind: string }[];
  since: number | null;
  reads: number;
  lastRead: number | null;
}

// Turning a name or an address into a receipt. Deterministic, database-only,
// callable from a query (the web page) and a mutation (the inbox).

const companyOf = (label: string) => label.split(" — ")[0];

export async function findEmployerSites(db: DatabaseReader, q: string) {
  const terms = searchTerms(q);
  if (!terms) return [];
  const hits = await db
    .query("subjects")
    .withSearchIndex("search_label", (s) => s.search("label", terms).eq("kind", "employer_site"))
    .take(25);
  return rankCompanies(q, hits, (h) => companyOf(h.label)).map((c) => ({
    subjectKey: c.item.key,
    label: c.item.label,
    company: companyOf(c.item.label),
    score: c.score,
  }));
}

export async function findBuildings(db: DatabaseReader, q: string) {
  const terms = addressTokens(q).join(" ");
  if (!terms) return [];
  const hits = await db
    .query("subjects")
    .withSearchIndex("search_label", (s) => s.search("label", terms).eq("kind", "building"))
    .take(25);
  return rankAddresses(q, hits, (h) => h.label).map((c) => ({ subjectKey: c.item.key, label: c.item.label, score: c.score }));
}

/** Every layoff file we hold, by source slug. One place, so nothing forgets a state. */
export const LAYOFF_STATES = {
  "ny-warn": "US-NY",
  "ca-warn": "US-CA",
  "md-warn": "US-MD",
  "co-warn": "US-CO",
  "nc-warn": "US-NC",
  "va-warn": "US-VA",
  "nj-warn": "US-NJ",
  "wi-warn": "US-WI",
} as const;

export async function noticesFor(db: DatabaseReader, subjectKeys: string[]): Promise<LayoffNoticeRow[]> {
  const rows: LayoffNoticeRow[] = [];
  // A subject's edits do not depend on which state's file is being read, so
  // they are fetched once per subject rather than once per subject per state —
  // seven times the reads for the same rows, on a path a stranger can call.
  const editsFor = new Map<string, { at: number; changed: string[]; before: any; after: any; identityKey: string }[]>();
  for (const key of subjectKeys) {
    const edits = (await db.query("changes").withIndex("by_subject", (q) => q.eq("subjectKey", key)).order("asc").take(50))
      .filter((c) => c.kind === "changed" && c.before && c.after)
      .map((c) => ({ at: c.detectedAt, changed: c.changed, before: c.before!, after: c.after!, identityKey: c.identityKey }));
    if (edits.length > 0) editsFor.set(key, edits);
  }
  for (const [slugName, jurisdiction] of Object.entries(LAYOFF_STATES) as [keyof typeof LAYOFF_STATES, LayoffNoticeRow["jurisdiction"]][]) {
    const src = await db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slugName)).unique();
    if (!src) continue;
    for (const key of subjectKeys) {
      const cur = await db
        .query("current")
        .withIndex("by_source_subject", (q) => q.eq("sourceId", src._id).eq("subjectKey", key))
        .collect();
      if (cur.length === 0) continue;
      const edits = editsFor.get(key) ?? [];
      for (const c of cur) {
        const f = c.fields;
        const amendments = edits.filter((e) => e.identityKey === c.identityKey).map(({ at, changed, before, after }) => ({ at, changed, before, after }));
        rows.push({
          company: String(f.company),
          siteAddress: String(f.siteAddress),
          workers: Number(f.employeesAffected) || 0,
          noticeDate: String(f.noticeDate ?? ""),
          // New Jersey publishes the month it posted a notice and no day.
          noticeMonth: f.noticeMonth ? String(f.noticeMonth) : undefined,
          // Maryland and New Jersey both write more than one date in this cell.
          effectiveDateRaw: f.effectiveDateRaw ? String(f.effectiveDateRaw) : undefined,
          stateNoticeId: f.noticeId ? String(f.noticeId) : undefined,
          stateVersion: f.version ? Number(f.version) : undefined,
          stateUpdates: f.updates ? String(f.updates) : undefined,
          effectiveDate: String(f.effectiveDate),
          postedDate: String(f.postedDate ?? f.processedDate ?? ""),
          // California's column is "Processed Date" — the day it handled the
          // notice, not the day it published one. It is never rendered as
          // publication.
          postedIsProcessed: !f.postedDate && Boolean(f.processedDate),
          jurisdiction,
          layoffOrClosure: f.layoffOrClosure ? String(f.layoffOrClosure) : undefined,
          reason: f.reason ? String(f.reason) : undefined,
          amendments: amendments.length > 0 ? amendments : undefined,
        });
      }
    }
  }
  return rows;
}

export async function stampsFor(db: DatabaseReader, bbl: string): Promise<BuildingStamp[]> {
  const src = await db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-hpd")).unique();
  if (!src) return [];
  const cur = await db
    .query("current")
    .withIndex("by_source_subject", (q) => q.eq("sourceId", src._id).eq("subjectKey", bbl))
    .collect();
  return cur
    .map((c) => ({
      status: String(c.fields.currentstatus),
      date: String(c.fields.currentstatusdate),
      hazardClass: String(c.fields.class ?? ""),
      certifiedBy: c.fields.certifiedbydate ? String(c.fields.certifiedbydate) : null,
      // The city's own words for what was wrong. The unit number never
      // leaves the row; the description is the whole point of the page.
      violationId: String(c.fields.violationid ?? ""),
      description: c.fields.novdescription ? String(c.fields.novdescription) : null,
      inspected: c.fields.inspectiondate ? String(c.fields.inspectiondate) : null,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Health Department inspections filed under the same building. A different
 * city file, the same 10-digit parcel number.
 */
export async function restaurantsFor(db: DatabaseReader, bbl: string): Promise<RestaurantRow[]> {
  const src = await db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-restaurants")).unique();
  if (!src) return [];
  const cur = await db
    .query("current")
    .withIndex("by_source_subject", (q) => q.eq("sourceId", src._id).eq("subjectKey", bbl))
    .collect();
  return cur
    .map((c) => ({
      dba: String(c.fields.dba ?? ""),
      inspectionDate: String(c.fields.inspectionDate ?? ""),
      action: String(c.fields.action ?? ""),
      grade: c.fields.grade ? String(c.fields.grade) : null,
      score: c.fields.score !== null && c.fields.score !== undefined ? Number(c.fields.score) : null,
      critical: String(c.fields.criticalFlag ?? "") === "Critical",
      description: c.fields.violationDescription ? String(c.fields.violationDescription) : null,
    }))
    .sort((a, b) => (a.inspectionDate < b.inspectionDate ? 1 : -1));
}

/**
 * The sentence-one claim, made countable: for one subject, every row we hold,
 * when we first and last saw it, how many times the file has been read since,
 * the row's hash, and the changes we recorded. Nothing here is asserted; it
 * is all read back from what ingest wrote.
 */
export async function versionsFor(db: DatabaseReader, subjectKeys: string[]): Promise<Held> {
  const rows: Held["rows"] = [];
  const changes: Held["changes"] = [];
  let earliest = Number.POSITIVE_INFINITY;
  const sourceIds = new Set<string>();
  for (const key of subjectKeys.slice(0, 12)) {
    const obs = await db
      .query("observations")
      .withIndex("by_subject_claim", (q) => q.eq("subjectKey", key))
      .take(300);
    const byIdentity = new Map<string, typeof obs>();
    for (const o of obs) {
      byIdentity.set(o.identityKey, [...(byIdentity.get(o.identityKey) ?? []), o]);
      sourceIds.add(o.sourceId);
      if (o.capturedAt < earliest) earliest = o.capturedAt;
    }
    for (const [identityKey, list] of byIdentity) {
      const sorted = [...list].sort((a, b) => a.capturedAt - b.capturedAt);
      const last = sorted.at(-1)!;
      const f = last.fields;
      const label =
        f.__subjectKind === "building"
          ? `Violation ${String(f.violationid ?? "")}${f.class ? ` (class ${String(f.class)})` : ""}`
          : `${String(f.company ?? "")} — ${String(f.siteAddress ?? "")}, notice dated ${String(f.noticeDate ?? "")}`;
      rows.push({ identityKey, label, firstSeen: sorted[0].capturedAt, lastSeen: last.capturedAt, versions: sorted.length, hash: last.fullHash });
    }
    const ch = await db.query("changes").withIndex("by_subject", (q) => q.eq("subjectKey", key)).order("desc").take(30);
    for (const c of ch) changes.push({ at: c.detectedAt, sentence: c.sentence, kind: c.kind });
  }
  // How many times the files have been read: a counter on the source row,
  // kept by every finished read. Counting snapshot rows here read up to
  // two thousand documents per file per page view, and grew by the day.
  let reads = 0;
  let lastRead = 0;
  for (const sourceId of sourceIds) {
    const src = await db.get(sourceId as Id<"sources">);
    if (!src) continue;
    reads += src.readCount ?? 0;
    if ((src.lastRunAt ?? 0) > lastRead) lastRead = src.lastRunAt ?? 0;
  }
  return {
    rows: rows.sort((a, b) => b.lastSeen - a.lastSeen),
    changes: changes.sort((a, b) => b.at - a.at).slice(0, 20),
    since: Number.isFinite(earliest) ? earliest : null,
    reads,
    lastRead: lastRead || null,
  };
}

const versionsValidator = v.object({
  rows: v.array(v.object({ identityKey: v.string(), label: v.string(), firstSeen: v.number(), lastSeen: v.number(), versions: v.number(), hash: v.string() })),
  changes: v.array(v.object({ at: v.number(), sentence: v.string(), kind: v.string() })),
  since: v.union(v.number(), v.null()),
  reads: v.number(),
  lastRead: v.union(v.number(), v.null()),
});

/** The versions behind a receipt, for the page. Employers may span several site keys. */
export const versions = query({
  args: { subjectKey: v.string(), q: v.optional(v.string()) },
  returns: versionsValidator,
  handler: async (ctx, { subjectKey, q }): Promise<Held> => {
    let keys = [subjectKey];
    if (q && !/^\d{10}$/.test(subjectKey)) {
      const sites = await findEmployerSites(ctx.db, q.replace(/-/g, " "));
      if (sites[0] && sites[0].score >= 0.6) {
        const company = sites[0].company;
        const matched = sites.filter((s) => sameCompany(s.company, company)).map((s) => s.subjectKey);
        if (matched.length > 0) keys = matched;
      }
    }
    return versionsFor(ctx.db, keys);
  },
});

async function versionsSince(db: DatabaseReader): Promise<string> {
  const first = await db.query("snapshots").order("asc").first();
  return first ? new Date(first.capturedAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

/**
 * Where the rows came from and when: the last full read of each file the
 * receipt draws on. A lawyer forwarding the receipt should not have to ask.
 */
async function provenanceFor(db: DatabaseReader, slugs: string[]): Promise<ReceiptOpts["provenance"]> {
  const out: NonNullable<ReceiptOpts["provenance"]> = [];
  for (const slugName of slugs) {
    const src = await db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slugName)).unique();
    if (!src) continue;
    const snaps = await db
      .query("snapshots")
      .withIndex("by_source_captured", (q) => q.eq("sourceId", src._id))
      .order("desc")
      .take(30);
    const full = snaps.find((s) => s.httpStatus !== 304) ?? snaps[0];
    if (!full) continue;
    out.push({
      publisher: PUBLISHER_NAME[slugName] ?? slugName,
      url: full.requestUrl,
      at: full.capturedAt,
      status: full.httpStatus,
      rows: src.rowCount ?? full.rowCount,
      lastChecked: src.lastRunAt ?? full.capturedAt,
      coverage: COVERAGE[slugName],
    });
  }
  return out;
}

/**
 * What each file actually covers, in its own terms. Taken from the adapters'
 * own findings; the receipt cannot claim a span it never read.
 */
const COVERAGE: Record<string, string> = {
  "ny-warn": "the state's current file",
  "ca-warn": "a rolling window the state overwrites",
  "md-warn": "the current year",
  "co-warn": "the current year",
  "nc-warn": "the current year",
  "va-warn": "back to 2010",
  "nj-warn": "back to 2004",
  "wi-warn": "the current year, with every revision the state numbers",
  "nyc-hpd": "the buildings we hold",
  "nyc-restaurants": "active restaurants only, three years back",
};

const PUBLISHER_NAME: Record<string, string> = {
  "ny-warn": "New York",
  "ca-warn": "California",
  "va-warn": "Virginia",
  "nj-warn": "New Jersey",
  "wi-warn": "Wisconsin",
  "md-warn": "Maryland",
  "nc-warn": "North Carolina",
  "co-warn": "Colorado",
  "nyc-hpd": "New York City",
  "nyc-restaurants": "New York City restaurants",
};

const SLUG_OF: Record<string, string> = Object.fromEntries(Object.entries(LAYOFF_STATES).map(([s, j]) => [j, s]));

export function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
}

/** Which employer is this text about? Every token of the company name must appear. */
export async function guessCompanyFromText(db: DatabaseReader, text: string): Promise<string | null> {
  const subjects = await db
    .query("subjects")
    .withIndex("by_kind_key", (q) => q.eq("kind", "employer_site"))
    .collect();
  let best: { company: string; score: number; n: number } | null = null;
  const seen = new Set<string>();
  for (const s of subjects) {
    const company = companyOf(s.label);
    const k = foldString(company);
    if (seen.has(k)) continue;
    seen.add(k);
    const score = companyMentionScore(text, company);
    if (score < 0.6) continue;
    const n = companyTokens(company).length;
    if (!best || score > best.score || (score === best.score && n > best.n)) best = { company, score, n };
  }
  return best?.company ?? null;
}

export async function buildReceipt(
  db: DatabaseReader,
  q: string,
): Promise<{ receipt: Receipt; matches: { company: string; score: number }[]; keys?: string[] }> {
  const since = await versionsSince(db);

  // The city's own parcel number — the one id on our building pages — must
  // work when pasted back to the inbox.
  if (/^\d{10}$/.test(q.trim())) {
    const key = q.trim();
    const subject = await db.query("subjects").withIndex("by_kind_key", (x) => x.eq("kind", "building").eq("key", key)).unique();
    if (subject) {
      const stamps = await stampsFor(db, key);
      const held = await versionsFor(db, [key]);
      return {
        receipt: buildingReceipt(subject.label, key, subject.label, stamps, {
          versionsSince: since,
          pageUrl: `${siteUrl()}/b/${key}`,
          restaurants: await restaurantsFor(db, key),
          provenance: await provenanceFor(db, ["nyc-hpd", "nyc-restaurants"]),
          held: { rows: held.rows.length, versions: held.rows.reduce((n, r) => n + r.versions, 0), reads: held.reads, since: held.since },
        }),
        matches: [],
      };
    }
  }

  if (looksLikeAddress(q)) {
    const b = await findBuildings(db, q);
    if (b[0] && b[0].score >= 0.6) {
      const stamps = await stampsFor(db, b[0].subjectKey);
      const held = await versionsFor(db, [b[0].subjectKey]);
      return {
        receipt: buildingReceipt(q, b[0].subjectKey, b[0].label, stamps, {
          versionsSince: since,
          pageUrl: `${siteUrl()}/b/${b[0].subjectKey}`,
          restaurants: await restaurantsFor(db, b[0].subjectKey),
          provenance: await provenanceFor(db, ["nyc-hpd", "nyc-restaurants"]),
          held: { rows: held.rows.length, versions: held.rows.reduce((n, r) => n + r.versions, 0), reads: held.reads, since: held.since },
        }),
        matches: [],
      };
    }
  }

  const sites = await findEmployerSites(db, q);
  const matches: { company: string; score: number }[] = [];
  for (const s of sites) if (!matches.some((m) => sameCompany(m.company, s.company))) matches.push({ company: s.company, score: s.score });

  if (sites[0] && sites[0].score >= 0.6) {
    const company = sites[0].company;
    const keys = sites.filter((s) => sameCompany(s.company, company)).map((s) => s.subjectKey);
    const rows = await noticesFor(db, keys);
    if (rows.length > 0) {
      const slugs = [...new Set(rows.map((r) => SLUG_OF[r.jurisdiction]).filter(Boolean))];
      const held = await versionsFor(db, keys);
      return {
        keys,
        receipt: layoffReceipt(q, keys[0], rows, {
          versionsSince: since,
          pageUrl: `${siteUrl()}/e/${urlSlug(sites[0].company)}`,
          provenance: await provenanceFor(db, slugs),
          held: { rows: held.rows.length, versions: held.rows.reduce((n, r) => n + r.versions, 0), reads: held.reads, since: held.since },
        }),
        matches: matches.slice(0, 5),
      };
    }
  }
  // Nothing filed: say so with a date and each file's last read, and make it
  // followable — the subject key is the question itself.
  const provenance = await provenanceFor(db, [...Object.keys(LAYOFF_STATES), "nyc-hpd"]);
  const followKey = companyTokens(q).length > 0 ? `q:${slug(q)}` : undefined;
  return {
    receipt: noMatchReceipt(q, matches.slice(0, 3).map((m) => m.company), { provenance, followKey }),
    matches: matches.slice(0, 5),
  };
}

const receiptValidator = v.object({
  kind: v.union(v.literal("layoff"), v.literal("building"), v.literal("none")),
  query: v.string(),
  subjectKey: v.optional(v.string()),
  headline: v.string(),
  blocks: v.array(v.array(v.string())),
  links: v.array(v.object({ label: v.string(), url: v.string() })),
  footer: v.array(v.string()),
});

/** The state file a row came from, for the export's last column. */
export const STATE_FILE: Record<string, string> = {
  "US-NY": "https://dol.ny.gov/warn-notices",
  "US-CA": "https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN/",
  "US-MD": "https://labor.maryland.gov/employment/warn.shtml",
  "US-CO": "https://cdle.colorado.gov/employers/layoff-separations/layoff-warn-list",
  "US-NC": "https://www.commerce.nc.gov/data-tools-reports/labor-market-data-tools/workforce-warn-reports/report-workforce-warn-summary-list-2026",
  "US-VA": "https://virginiaworks.gov/im-an-employer/retain-and-grow/warn-notices/",
  "US-NJ": "https://www.nj.gov/labor/business-services/layoffs-and-closing/file-warn-notice/",
  "US-WI": "https://dwd.wisconsin.gov/dislocatedworker/warn/",
};

/**
 * The lawyer's export for one employer: every filing we hold, one row each,
 * as CSV. Null when the name matches no layoff filing.
 */
export const exportCsv = query({
  args: { q: v.string() },
  returns: v.union(v.null(), v.object({ csv: v.string(), filename: v.string(), rows: v.number() })),
  handler: async (ctx, { q }) => {
    const clean = q.replace(/-/g, " ").trim().slice(0, 120);
    if (!clean) return null;
    const built = await buildReceipt(ctx.db, clean);
    if (built.receipt.kind !== "layoff" || !built.keys?.length) return null;
    const rows = await noticesFor(ctx.db, built.keys);
    const company = built.matches[0]?.company ?? clean;
    return {
      csv: layoffCsv(rows, { fileFor: (r) => STATE_FILE[r.jurisdiction] ?? "" }),
      filename: `notice-${urlSlug(company).slice(0, 40)}.csv`,
      rows: rows.length,
    };
  },
});

/**
 * One building, by the city's own parcel number. Receipts already link here,
 * so the address in an email and the page it points at say the same thing.
 */
export const building = query({
  args: { key: v.string() },
  returns: v.object({
    receipt: receiptValidator,
    label: v.string(),
    stamps: v.array(
      v.object({
        status: v.string(),
        date: v.string(),
        hazardClass: v.string(),
        certifiedBy: v.union(v.string(), v.null()),
        violationId: v.string(),
        description: v.union(v.string(), v.null()),
        inspected: v.union(v.string(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, { key }) => {
    const clean = key.trim().slice(0, 20);
    const subject = await ctx.db
      .query("subjects")
      .withIndex("by_kind_key", (q) => q.eq("kind", "building").eq("key", clean))
      .unique();
    if (!subject) return { receipt: noMatchReceipt(clean, []), label: clean, stamps: [] };
    const stamps = await stampsFor(ctx.db, clean);
    const since = await versionsSince(ctx.db);
    const held = await versionsFor(ctx.db, [clean]);
    return {
      receipt: buildingReceipt(subject.label, clean, subject.label, stamps, {
        versionsSince: since,
        restaurants: await restaurantsFor(ctx.db, clean),
        provenance: await provenanceFor(ctx.db, ["nyc-hpd", "nyc-restaurants"]),
        held: { rows: held.rows.length, versions: held.rows.reduce((n, r) => n + r.versions, 0), reads: held.reads, since: held.since },
      }),
      label: subject.label,
      stamps: stamps.map((s) => ({
        status: s.status,
        date: s.date,
        hazardClass: s.hazardClass,
        certifiedBy: s.certifiedBy,
        violationId: s.violationId ?? "",
        description: s.description ?? null,
        inspected: s.inspected ?? null,
      })),
    };
  },
});

/** The web version of "email us a name". */
export const employer = query({
  args: { q: v.string() },
  returns: v.object({
    receipt: receiptValidator,
    matches: v.array(v.object({ company: v.string(), score: v.number() })),
    /** The filing in fields, so the page can go and ask what they said in public. */
    filing: v.optional(v.object({ employer: v.string(), filingDate: v.string(), statedReason: v.optional(v.string()) })),
    /** The one slug this employer's page lives at, so two spellings share one URL. */
    canonical: v.optional(v.string()),
  }),
  handler: async (ctx, { q }) => {
    type Filing = { employer: string; filingDate: string; statedReason?: string } | undefined;
    const clean = q.replace(/-/g, " ").trim().slice(0, 120);
    if (!clean) return { receipt: noMatchReceipt("", []), matches: [], filing: undefined as Filing, canonical: undefined as string | undefined };
    const { keys, ...built } = await buildReceipt(ctx.db, clean);
    if (built.receipt.kind !== "layoff" || !built.receipt.subjectKey) return { ...built, filing: undefined as Filing, canonical: undefined as string | undefined };
    // Every key the receipt was built from. One employer's filings are spread
    // across a subject per site and per state; reading back only the first
    // gave New Jersey's dateless rows and nothing else.
    const rows = await noticesFor(ctx.db, keys ?? [built.receipt.subjectKey]);
    // The newest filing that actually carries a notice date. New Jersey
    // publishes only the month, so its rows cannot anchor a search around a
    // date — and an empty date here rendered as "in the month around ." on the
    // page and was passed to a paid search as a blank.
    const dated = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.noticeDate)).sort((a, b) => (a.noticeDate < b.noticeDate ? 1 : a.noticeDate > b.noticeDate ? -1 : 0));
    const first = dated[0];
    const filing: Filing = first ? { employer: first.company, filingDate: first.noticeDate, statedReason: first.reason } : undefined;
    // The name the match settled on — stable whichever state's row is read
    // back first, so the URL does not flip between spellings.
    const canonical: string | undefined = built.matches[0] ? urlSlug(built.matches[0].company) : undefined;
    return { ...built, filing, canonical };
  },
});
