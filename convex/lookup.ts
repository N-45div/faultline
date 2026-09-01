import { v } from "convex/values";
import { query } from "./_generated/server";
import type { DatabaseReader } from "./_generated/server";
import { addressTokens, companyMentionScore, companyTokens, looksLikeAddress, rankAddresses, rankCompanies } from "../engine/match";
import { foldString, slug } from "../engine/canon";
import {
  buildingReceipt,
  layoffReceipt,
  noMatchReceipt,
  type BuildingStamp,
  type LayoffNoticeRow,
  type Receipt,
} from "../engine/receipt";

// Turning a name or an address into a receipt. Deterministic, database-only,
// callable from a query (the web page) and a mutation (the inbox).

const companyOf = (label: string) => label.split(" — ")[0];

export async function findEmployerSites(db: DatabaseReader, q: string) {
  const terms = companyTokens(q).join(" ");
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
} as const;

export async function noticesFor(db: DatabaseReader, subjectKeys: string[]): Promise<LayoffNoticeRow[]> {
  const rows: LayoffNoticeRow[] = [];
  for (const [slugName, jurisdiction] of Object.entries(LAYOFF_STATES) as [keyof typeof LAYOFF_STATES, LayoffNoticeRow["jurisdiction"]][]) {
    const src = await db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slugName)).unique();
    if (!src) continue;
    for (const key of subjectKeys) {
      const cur = await db
        .query("current")
        .withIndex("by_source_subject", (q) => q.eq("sourceId", src._id).eq("subjectKey", key))
        .collect();
      for (const c of cur) {
        const f = c.fields;
        rows.push({
          company: String(f.company),
          siteAddress: String(f.siteAddress),
          workers: Number(f.employeesAffected) || 0,
          noticeDate: String(f.noticeDate),
          effectiveDate: String(f.effectiveDate),
          postedDate: String(f.postedDate ?? f.processedDate ?? ""),
          jurisdiction,
          layoffOrClosure: f.layoffOrClosure ? String(f.layoffOrClosure) : undefined,
          reason: f.reason ? String(f.reason) : undefined,
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
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

async function versionsSince(db: DatabaseReader): Promise<string> {
  const first = await db.query("snapshots").order("asc").first();
  return first ? new Date(first.capturedAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function siteUrl(): string {
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

export async function buildReceipt(db: DatabaseReader, q: string): Promise<{ receipt: Receipt; matches: { company: string; score: number }[] }> {
  const since = await versionsSince(db);

  // The city's own parcel number — the one id on our building pages — must
  // work when pasted back to the inbox.
  if (/^\d{10}$/.test(q.trim())) {
    const key = q.trim();
    const subject = await db.query("subjects").withIndex("by_kind_key", (x) => x.eq("kind", "building").eq("key", key)).unique();
    if (subject) {
      const stamps = await stampsFor(db, key);
      return { receipt: buildingReceipt(subject.label, key, subject.label, stamps, { versionsSince: since, pageUrl: `${siteUrl()}/b/${key}` }), matches: [] };
    }
  }

  if (looksLikeAddress(q)) {
    const b = await findBuildings(db, q);
    if (b[0] && b[0].score >= 0.6) {
      const stamps = await stampsFor(db, b[0].subjectKey);
      return {
        receipt: buildingReceipt(q, b[0].subjectKey, b[0].label, stamps, { versionsSince: since, pageUrl: `${siteUrl()}/b/${b[0].subjectKey}` }),
        matches: [],
      };
    }
  }

  const sites = await findEmployerSites(db, q);
  const matches: { company: string; score: number }[] = [];
  for (const s of sites) if (!matches.some((m) => foldString(m.company) === foldString(s.company))) matches.push({ company: s.company, score: s.score });

  if (sites[0] && sites[0].score >= 0.6) {
    const company = foldString(sites[0].company);
    const keys = sites.filter((s) => foldString(s.company) === company).map((s) => s.subjectKey);
    const rows = await noticesFor(db, keys);
    if (rows.length > 0) {
      return {
        receipt: layoffReceipt(q, keys[0], rows, { versionsSince: since, pageUrl: `${siteUrl()}/e/${slug(sites[0].company)}` }),
        matches: matches.slice(0, 5),
      };
    }
  }
  return { receipt: noMatchReceipt(q, matches.slice(0, 3).map((m) => m.company)), matches: matches.slice(0, 5) };
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

/**
 * One building, by the city's own parcel number. Receipts already link here,
 * so the address in an email and the page it points at say the same thing.
 */
export const building = query({
  args: { key: v.string() },
  returns: v.object({
    receipt: receiptValidator,
    label: v.string(),
    stamps: v.array(v.object({ status: v.string(), date: v.string(), hazardClass: v.string(), certifiedBy: v.union(v.string(), v.null()) })),
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
    return {
      receipt: buildingReceipt(subject.label, clean, subject.label, stamps, { versionsSince: since }),
      label: subject.label,
      stamps,
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
  }),
  handler: async (ctx, { q }) => {
    type Filing = { employer: string; filingDate: string; statedReason?: string } | undefined;
    const clean = q.replace(/-/g, " ").trim().slice(0, 120);
    if (!clean) return { receipt: noMatchReceipt("", []), matches: [], filing: undefined as Filing };
    const built = await buildReceipt(ctx.db, clean);
    if (built.receipt.kind !== "layoff" || !built.receipt.subjectKey) return { ...built, filing: undefined as Filing };
    const rows = await noticesFor(ctx.db, [built.receipt.subjectKey]);
    const first = [...rows].sort((a, b) => (a.noticeDate < b.noticeDate ? 1 : -1))[0];
    const filing: Filing = first ? { employer: first.company, filingDate: first.noticeDate, statedReason: first.reason } : undefined;
    return { ...built, filing };
  },
});
