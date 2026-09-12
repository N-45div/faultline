import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { PUBLISHER } from "./wall";

// Git for the files the government overwrites. Every read is a commit: the
// bytes are hashed, the rows are diffed against the last commit, and each
// change is kept with its before and its after. These queries show that
// history the way a developer reads a repository — a log, a commit, a diff —
// because that is the plainest possible proof that the old version existed.

const shortHash = (h: string) => h.slice(0, 12);

const fields = v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()));

const changeShape = v.object({
  id: v.string(),
  kind: v.union(v.literal("added"), v.literal("changed"), v.literal("removed")),
  identityKey: v.string(),
  subjectKey: v.string(),
  label: v.string(),
  changed: v.array(v.string()),
  before: v.optional(fields),
  after: v.optional(fields),
  sentence: v.string(),
  at: v.number(),
});

/** What a row is called in a diff: the subject label the adapter wrote. */
function labelOf(f: Record<string, string | number | boolean | null> | undefined, identityKey: string): string {
  const l = f?.__subjectLabel;
  return l ? String(l) : identityKey;
}

/** Fields that are the record, not the plumbing. */
function publicFields(f: Record<string, string | number | boolean | null> | undefined) {
  if (!f) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, val] of Object.entries(f)) if (!k.startsWith("__") && val !== null && val !== "") out[k] = val;
  return out;
}

/** The ten files: latest commit, its hash, when, how many rows. */
export const index = query({
  args: {},
  returns: v.array(
    v.object({
      slug: v.string(),
      publisher: v.string(),
      url: v.string(),
      rows: v.number(),
      reads: v.number(),
      latest: v.union(v.null(), v.object({ hash: v.string(), at: v.number(), status: v.number() })),
    }),
  ),
  handler: async (ctx) => {
    const sources = await ctx.db.query("sources").collect();
    const out = [];
    for (const s of sources) {
      const snap = await ctx.db.query("snapshots").withIndex("by_source_captured", (q) => q.eq("sourceId", s._id)).order("desc").first();
      out.push({
        slug: s.slug,
        publisher: PUBLISHER[s.slug] ?? s.slug,
        url: snap?.requestUrl ?? "",
        rows: s.currentCount ?? s.rowCount ?? 0,
        reads: s.readCount ?? 0,
        latest: snap ? { hash: shortHash(snap.bodySha256), at: snap.capturedAt, status: snap.httpStatus } : null,
      });
    }
    return out.sort((a, b) => (b.latest?.at ?? 0) - (a.latest?.at ?? 0));
  },
});

/**
 * One file's commit log: the last reads, newest first, each with the hash of
 * the bytes and what the diff against the read before it found. A 304 is a
 * commit with nothing in it — the state said "unchanged" and we recorded that
 * it said so.
 */
export const log = query({
  args: { slug: v.string(), limit: v.optional(v.number()) },
  returns: v.union(
    v.null(),
    v.object({
      slug: v.string(),
      publisher: v.string(),
      url: v.string(),
      rows: v.number(),
      reads: v.number(),
      /** Newest first. A run of reads that changed nothing is one entry, not forty. */
      commits: v.array(
        v.union(
          v.object({
            kind: v.literal("commit"),
            id: v.string(),
            hash: v.string(),
            at: v.number(),
            status: v.number(),
            rows: v.number(),
            added: v.number(),
            changed: v.number(),
            removed: v.number(),
            more: v.boolean(),
          }),
          v.object({ kind: v.literal("quiet"), count: v.number(), from: v.number(), to: v.number(), hash: v.string() }),
        ),
      ),
      /** How many reads the log walked to find these. */
      walked: v.number(),
    }),
  ),
  handler: async (ctx, { slug, limit }) => {
    const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!src) return null;
    // Walk enough reads to find commits worth showing: a file read every half
    // hour answers "unchanged" forty times a day, and a log of those is noise.
    const snaps = await ctx.db
      .query("snapshots")
      .withIndex("by_source_captured", (q) => q.eq("sourceId", src._id))
      .order("desc")
      .take(400);
    const want = Math.min(limit ?? 30, 60);
    type Entry =
      | { kind: "commit"; id: string; hash: string; at: number; status: number; rows: number; added: number; changed: number; removed: number; more: boolean }
      | { kind: "quiet"; count: number; from: number; to: number; hash: string };
    const commits: Entry[] = [];
    let shown = 0;
    for (const snap of snaps) {
      if (shown >= want) break;
      const ch = snap.httpStatus === 304 ? [] : await ctx.db.query("changes").withIndex("by_snapshot", (q) => q.eq("snapshotId", snap._id)).take(201);
      let added = 0;
      let changed = 0;
      let removed = 0;
      for (const c of ch.slice(0, 200)) {
        if (c.kind === "added") added++;
        else if (c.kind === "changed") changed++;
        else removed++;
      }
      if (added + changed + removed === 0) {
        const last = commits.at(-1);
        // Newest first: a run's "to" is its first member; "from" keeps moving back.
        if (last && last.kind === "quiet") {
          last.count++;
          last.from = snap.capturedAt;
        } else commits.push({ kind: "quiet", count: 1, from: snap.capturedAt, to: snap.capturedAt, hash: shortHash(snap.bodySha256) });
        continue;
      }
      shown++;
      commits.push({ kind: "commit", id: String(snap._id), hash: shortHash(snap.bodySha256), at: snap.capturedAt, status: snap.httpStatus, rows: snap.rowCount, added, changed, removed, more: ch.length > 200 });
    }
    const latestUrl = snaps.find((x) => x.requestUrl)?.requestUrl ?? "";
    return {
      slug,
      publisher: PUBLISHER[slug] ?? slug,
      url: latestUrl,
      rows: src.currentCount ?? src.rowCount ?? 0,
      reads: src.readCount ?? 0,
      commits,
      walked: snaps.length,
    };
  },
});

/** One commit: the read, and every change it produced, with before and after. */
export const commit = query({
  args: { id: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      slug: v.string(),
      publisher: v.string(),
      hash: v.string(),
      fullHash: v.string(),
      at: v.number(),
      status: v.number(),
      rows: v.number(),
      url: v.string(),
      changes: v.array(changeShape),
      more: v.boolean(),
    }),
  ),
  handler: async (ctx, { id }) => {
    const snapId = ctx.db.normalizeId("snapshots", id);
    if (!snapId) return null;
    const snap = await ctx.db.get(snapId);
    if (!snap) return null;
    const src = await ctx.db.get(snap.sourceId);
    const ch = await ctx.db.query("changes").withIndex("by_snapshot", (q) => q.eq("snapshotId", snapId)).take(301);
    const order = { removed: 0, changed: 1, added: 2 };
    return {
      slug: src?.slug ?? "",
      publisher: PUBLISHER[src?.slug ?? ""] ?? src?.slug ?? "",
      hash: shortHash(snap.bodySha256),
      fullHash: snap.bodySha256,
      at: snap.capturedAt,
      status: snap.httpStatus,
      rows: snap.rowCount,
      url: snap.requestUrl,
      changes: ch
        .slice(0, 300)
        .sort((a, b) => order[a.kind] - order[b.kind] || a.identityKey.localeCompare(b.identityKey))
        .map((c) => ({
          id: String(c._id),
          kind: c.kind,
          identityKey: c.identityKey,
          subjectKey: c.subjectKey,
          label: labelOf(c.after ?? c.before, c.identityKey),
          changed: c.changed,
          before: publicFields(c.before),
          after: publicFields(c.after),
          sentence: c.sentence,
          at: c.detectedAt,
        })),
      more: ch.length > 300,
    };
  },
});

/**
 * What the government deleted: every row that left a file, newest first,
 * across every file, with the version we still hold. The agencies' own sites
 * cannot show this page; the row is gone from them.
 */
export const erasures = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.string(),
      slug: v.string(),
      publisher: v.string(),
      at: v.number(),
      label: v.string(),
      sentence: v.string(),
      before: v.optional(fields),
      snapshotId: v.string(),
      subjectKey: v.string(),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("changes")
      .withIndex("by_kind", (q) => q.eq("kind", "removed"))
      .order("desc")
      .take(Math.min(limit ?? 60, 200));
    const slugs = new Map<Id<"sources">, string>();
    const out = [];
    // A row that flapped in and out of a file is one deletion to a reader,
    // shown once at its latest removal — not three entries in a row.
    const seen = new Set<string>();
    for (const c of rows) {
      const key = `${c.sourceId}/${c.identityKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let slug = slugs.get(c.sourceId);
      if (!slug) {
        slug = (await ctx.db.get(c.sourceId))?.slug ?? "";
        slugs.set(c.sourceId, slug);
      }
      out.push({
        id: String(c._id),
        slug,
        publisher: PUBLISHER[slug] ?? slug,
        at: c.detectedAt,
        label: labelOf(c.before, c.identityKey),
        sentence: c.sentence,
        before: publicFields(c.before),
        snapshotId: String(c.snapshotId),
        subjectKey: c.subjectKey,
      });
    }
    return out;
  },
});
