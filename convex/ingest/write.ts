import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { groupForWall } from "../../engine/wall";
import { scoreCompany } from "../../engine/match";
import { paused } from "../guard";
const MAX_ALERTS_PER_BATCH = 200;
/** Every active follow is read into memory per batch; this bounds that read. */
const MAX_TRACKED_SUBSCRIPTIONS = 2000;

// Everything in this file runs in the V8 runtime and imports no adapter: the
// Node action parses, hashes, diffs and renders; this side only writes.

const scalar = v.union(v.string(), v.number(), v.boolean(), v.null());
const fields = v.record(v.string(), scalar);
const subject = v.object({
  kind: v.union(v.literal("building"), v.literal("employer_site")),
  key: v.string(),
  label: v.string(),
});

const WALL_CAP = 50;
const LOCK_MS = 10 * 60_000;

/** Runs every minute. Schedules one action per due source and takes a lock. */
export const tick = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    if (paused("ingest")) return 0;
    const now = Date.now();
    const due = await ctx.db
      .query("sources")
      .withIndex("by_due", (q) => q.eq("status", "active").lte("nextRunAt", now))
      .take(20);
    let scheduled = 0;
    for (const s of due) {
      if (s.lockedUntil && s.lockedUntil > now) continue;
      await ctx.db.patch(s._id, { lockedUntil: now + LOCK_MS });
      await ctx.scheduler.runAfter(0, internal.ingest.fetch.runSource, { slug: s.slug });
      scheduled++;
    }
    return scheduled;
  },
});

export const getBySlug = internalQuery({
  args: { slug: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("sources"),
      slug: v.string(),
      emit: v.boolean(),
      cursor: v.optional(v.string()),
      lastEtag: v.optional(v.string()),
      lastBodySha256: v.optional(v.string()),
      consecutiveFailures: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { slug }) => {
    const s = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!s) return null;
    return {
      _id: s._id,
      slug: s.slug,
      emit: s.emit,
      cursor: s.cursor,
      lastEtag: s.lastEtag,
      lastBodySha256: s.lastBodySha256,
      consecutiveFailures: s.consecutiveFailures,
    };
  },
});

/** The only thing ingest reads about the world: who is being looked at. */
export const targetKeys = internalQuery({
  args: { sourceId: v.id("sources") },
  returns: v.array(v.string()),
  handler: async (ctx, { sourceId }) => {
    const rows = await ctx.db
      .query("targets")
      .withIndex("by_source_active", (q) => q.eq("sourceId", sourceId).eq("active", true))
      .collect();
    return rows.map((t) => t.subjectKey);
  },
});

/**
 * The "before" side of the diff. Whole-file sources need every current row so
 * absence can be detected; filtered sources only need the keys they fetched.
 */
export const prevFor = internalQuery({
  args: {
    sourceId: v.id("sources"),
    mode: v.union(v.literal("all"), v.literal("keys")),
    identityKeys: v.array(v.string()),
  },
  // An array, not a record: Convex caps object keys at 1,024 and a busy
  // source has more current rows than that.
  returns: v.array(v.object({ identityKey: v.string(), sigHash: v.string(), fullHash: v.string(), fields })),
  handler: async (ctx, { sourceId, mode, identityKeys }) => {
    const pick = (r: Doc<"current">) => ({ identityKey: r.identityKey, sigHash: r.sigHash, fullHash: r.fullHash, fields: r.fields });
    if (mode === "all") {
      const rows = await ctx.db
        .query("current")
        .withIndex("by_source_identity", (q) => q.eq("sourceId", sourceId))
        .collect();
      return rows.map(pick);
    }
    const out: ReturnType<typeof pick>[] = [];
    for (const key of identityKeys) {
      const r = await ctx.db
        .query("current")
        .withIndex("by_source_identity", (q) => q.eq("sourceId", sourceId).eq("identityKey", key))
        .unique();
      if (r) out.push(pick(r));
    }
    return out;
  },
});

export const addTargets = internalMutation({
  args: {
    slug: v.string(),
    subjectKeys: v.array(v.string()),
    addedBy: v.union(v.literal("standing"), v.literal("case")),
  },
  returns: v.number(),
  handler: async (ctx, { slug, subjectKeys, addedBy }) => {
    const s = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!s) throw new Error(`no source ${slug}`);
    let added = 0;
    for (const subjectKey of subjectKeys) {
      const existing = await ctx.db
        .query("targets")
        .withIndex("by_source_subject", (q) => q.eq("sourceId", s._id).eq("subjectKey", subjectKey))
        .unique();
      if (existing) {
        if (!existing.active) await ctx.db.patch(existing._id, { active: true });
        continue;
      }
      await ctx.db.insert("targets", { sourceId: s._id, subjectKey, active: true, addedBy });
      added++;
    }
    return added;
  },
});

// ---- the commit, in three parts ------------------------------------------
//
// A cycle used to be one mutation. That works for a 193-row state file and
// falls over on a city: NYC HPD returns ~1,800 rows a cycle, and at four
// database operations a row one transaction blows past what Convex will let a
// single function do ("too many system operations"). So a cycle is now a
// snapshot, then batches of rows, then a finish. Each batch writes a row's new
// version, its `current` pointer and its change event together, so a batch that
// never runs loses nothing: the next cycle re-reads the file, finds those rows
// still differ from `current`, and commits them then.

const snapshotArg = v.object({
  capturedAt: v.number(),
  requestUrl: v.string(),
  httpStatus: v.number(),
  etag: v.optional(v.string()),
  lastModified: v.optional(v.string()),
  bodySha256: v.string(),
  bodyStorageId: v.optional(v.id("_storage")),
  rowCount: v.number(),
  degraded: v.boolean(),
});

const observationArg = v.object({
  identityKey: v.string(),
  subject,
  claimKind: v.string(),
  assertedAt: v.string(),
  fields,
  sigHash: v.string(),
  fullHash: v.string(),
});

const changeArg = v.object({
  identityKey: v.string(),
  subjectKey: v.string(),
  kind: v.union(v.literal("added"), v.literal("changed"), v.literal("removed")),
  changed: v.array(v.string()),
  before: v.optional(fields),
  after: v.optional(fields),
  sentence: v.string(),
});

/** One row per fetch. The bytes are pinned only when something moved. */
export const beginCommit = internalMutation({
  args: { sourceId: v.id("sources"), snapshot: snapshotArg },
  returns: v.id("snapshots"),
  handler: async (ctx, args) => {
    const now = args.snapshot.capturedAt;
    // A 304 carries no rows; the count from the last full read stands, so a
    // page reading "unchanged" never shows a file as empty.
    if (args.snapshot.httpStatus !== 304 && args.snapshot.rowCount > 0) {
      await ctx.db.patch(args.sourceId, { rowCount: args.snapshot.rowCount });
    }
    return await ctx.db.insert("snapshots", {
      sourceId: args.sourceId,
      ...args.snapshot,
      pinnedUntil: args.snapshot.bodyStorageId ? now + 14 * 86_400_000 : undefined,
    });
  },
});

/**
 * A slice of one cycle: these rows' new versions, their `current` pointers and
 * the change events they produced, written together.
 */
export const commitBatch = internalMutation({
  args: {
    sourceId: v.id("sources"),
    snapshotId: v.id("snapshots"),
    capturedAt: v.number(),
    observations: v.array(observationArg),
    changes: v.array(changeArg),
    sourceUrl: v.string(),
  },
  returns: v.object({ observations: v.number(), changes: v.number(), emitted: v.boolean() }),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error("source vanished");
    const now = args.capturedAt;
    const emit = source.emit;

    // Many rows share one building. Look each subject up once per batch.
    const subjectsSeen = new Set<string>();
    for (const o of args.observations) {
      const k = `${o.subject.kind}/${o.subject.key}`;
      if (subjectsSeen.has(k)) continue;
      subjectsSeen.add(k);
      await upsertSubject(ctx, o.subject);
    }

    for (const o of args.observations) {
      const observationId = await ctx.db.insert("observations", {
        sourceId: args.sourceId,
        snapshotId: args.snapshotId,
        identityKey: o.identityKey,
        subjectKey: o.subject.key,
        claimKind: o.claimKind,
        assertedAt: o.assertedAt,
        capturedAt: now,
        fields: o.fields,
        sigHash: o.sigHash,
        fullHash: o.fullHash,
      });
      const cur = await ctx.db
        .query("current")
        .withIndex("by_source_identity", (q) => q.eq("sourceId", args.sourceId).eq("identityKey", o.identityKey))
        .unique();
      if (cur) {
        await ctx.db.patch(cur._id, {
          observationId,
          sigHash: o.sigHash,
          fullHash: o.fullHash,
          fields: o.fields,
          updatedAt: now,
          prevSigHash: cur.sigHash !== o.sigHash ? cur.sigHash : cur.prevSigHash,
          prevUpdatedAt: cur.sigHash !== o.sigHash ? cur.updatedAt : cur.prevUpdatedAt,
        });
      } else {
        await ctx.db.insert("current", {
          sourceId: args.sourceId,
          identityKey: o.identityKey,
          subjectKey: o.subject.key,
          observationId,
          sigHash: o.sigHash,
          fullHash: o.fullHash,
          fields: o.fields,
          updatedAt: now,
        });
      }
    }

    // A row that left the file leaves `current`, so a reappearance reads as
    // "added" again rather than as a silent edit.
    for (const c of args.changes) {
      if (c.kind !== "removed") continue;
      const cur = await ctx.db
        .query("current")
        .withIndex("by_source_identity", (q) => q.eq("sourceId", args.sourceId).eq("identityKey", c.identityKey))
        .unique();
      if (cur) await ctx.db.delete(cur._id);
    }

    const changeIds: Id<"changes">[] = [];
    for (const c of args.changes) {
      changeIds.push(
        await ctx.db.insert("changes", {
          sourceId: args.sourceId,
          subjectKey: c.subjectKey,
          identityKey: c.identityKey,
          kind: c.kind,
          detectedAt: now,
          changed: c.changed.slice(0, 16),
          before: c.before,
          after: c.after,
          sentence: c.sentence,
          emit,
          snapshotId: args.snapshotId,
        }),
      );
    }

    if (emit && args.changes.length > 0) {
      // Nine violations at one building become one line that says nine, and
      // the city's stamp outranks "will be reinspected". The wall shows the
      // last WALL_CAP, so writing more than that is work that is deleted below.
      for (const row of groupForWall(args.changes).slice(0, WALL_CAP)) {
        await ctx.db.insert("recentChanges", {
          sourceId: args.sourceId,
          changeId: changeIds[row.first],
          createdAt: now,
          sentence: row.sentence,
          sourceUrl: args.sourceUrl,
          subjectKey: row.subjectKey,
          count: row.count,
          weight: row.weight,
        });
      }
      await trimWall(ctx, args.sourceId);
      await enqueueAlerts(ctx, args.changes, args.sourceUrl);
    }
    if (args.changes.length > 0) await bumpPulse(ctx, args.sourceId, now, args.changes.length);

    return { observations: args.observations.length, changes: args.changes.length, emitted: emit };
  },
});

/** Close the cycle: release the lock and set the next run. */
export const finishCommit = internalMutation({
  args: {
    sourceId: v.id("sources"),
    capturedAt: v.number(),
    bodySha256: v.string(),
    etag: v.optional(v.string()),
    next: v.object({ nextRunAt: v.number(), cursor: v.optional(v.string()), lastStatus: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error("source vanished");
    await ctx.db.patch(args.sourceId, {
      lastRunAt: args.capturedAt,
      nextRunAt: args.next.nextRunAt,
      cursor: args.next.cursor ?? source.cursor,
      lastStatus: args.next.lastStatus,
      lastEtag: args.etag ?? source.lastEtag,
      lastBodySha256: args.bodySha256,
      lockedUntil: undefined,
      consecutiveFailures: 0,
      shadowCycles: source.emit ? source.shadowCycles : source.shadowCycles + 1,
    });
    return null;
  },
});
export const fail = internalMutation({
  args: { sourceId: v.id("sources"), error: v.string(), retryInMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { sourceId, error, retryInMs }) => {
    const s = await ctx.db.get(sourceId);
    if (!s) return null;
    await ctx.db.patch(sourceId, {
      lastRunAt: Date.now(),
      nextRunAt: Date.now() + retryInMs,
      lastStatus: `error: ${error.slice(0, 300)}`,
      lockedUntil: undefined,
      consecutiveFailures: s.consecutiveFailures + 1,
    });
    return null;
  },
});
async function upsertSubject(ctx: { db: any }, s: { kind: "building" | "employer_site"; key: string; label: string }) {
  const existing: Doc<"subjects"> | null = await ctx.db
    .query("subjects")
    .withIndex("by_kind_key", (q: any) => q.eq("kind", s.kind).eq("key", s.key))
    .unique();
  if (!existing) await ctx.db.insert("subjects", s);
  else if (existing.label !== s.label && s.label) await ctx.db.patch(existing._id, { label: s.label });
}

/**
 * The public wall is bounded per source and trimmed once per batch. Trimming
 * after every single row meant re-reading the whole wall for every change —
 * fine for a state file, ruinous for a city.
 */
async function trimWall(ctx: { db: any }, sourceId: Id<"sources">) {
  const rows: Doc<"recentChanges">[] = await ctx.db
    .query("recentChanges")
    .withIndex("by_source", (q: any) => q.eq("sourceId", sourceId))
    .order("asc")
    .collect();
  for (const r of rows.slice(0, Math.max(0, rows.length - WALL_CAP))) await ctx.db.delete(r._id);
}

async function bumpPulse(ctx: { db: any }, sourceId: Id<"sources">, now: number, count: number) {
  const minute = Math.floor(now / 60_000);
  const existing: Doc<"pulseBuckets"> | null = await ctx.db
    .query("pulseBuckets")
    .withIndex("by_source_minute", (q: any) => q.eq("sourceId", sourceId).eq("minute", minute))
    .unique();
  if (existing) await ctx.db.patch(existing._id, { count: existing.count + count });
  else await ctx.db.insert("pulseBuckets", { sourceId, minute, count });
}

/** After an on-demand pull resolves an address, remember which building the email was about. */
export const markInboxSubject = internalMutation({
  args: { inboxId: v.id("inbox"), subjectKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { inboxId, subjectKey }) => {
    await ctx.db.patch(inboxId, { matchedSubjectKey: subjectKey });
    return null;
  },
});

/**
 * FOLLOW means: tell me when this filing changes. Ingest only queues the news
 * — one row per follower per change — and `digest.flush` decides when to send,
 * because a city file that moves 200 rows at once must never become 200
 * emails. Every active subscription is read once per batch and matched in
 * memory: the alternative is one query per subject, and a batch touches
 * hundreds of subjects.
 */
async function enqueueAlerts(
  ctx: { db: any },
  changes: { subjectKey: string; sentence: string; kind: "added" | "changed" | "removed"; after?: Record<string, string | number | boolean | null> }[],
  sourceUrl: string,
) {
  const subs: Doc<"subscriptions">[] = await ctx.db
    .query("subscriptions")
    .withIndex("by_subject")
    .take(MAX_TRACKED_SUBSCRIPTIONS);
  if (subs.length === 0) return;
  const followers = new Map<string, Doc<"subscriptions">[]>();
  // A follow on a NAME, not a filing: "tell me if anything appears under
  // Amazon". Matched against each newly added row's employer.
  const nameWatches: { query: string; sub: Doc<"subscriptions"> }[] = [];
  for (const s of subs) {
    if (!s.active) continue;
    if (s.subjectKey.startsWith("q:")) nameWatches.push({ query: s.subjectKey.slice(2).replace(/-/g, " "), sub: s });
    else followers.set(s.subjectKey, [...(followers.get(s.subjectKey) ?? []), s]);
  }
  if (followers.size === 0 && nameWatches.length === 0) return;

  const now = Date.now();
  let queued = 0;
  const seen = new Set<string>();
  for (const c of changes) {
    const byName =
      c.kind === "added" && c.after?.company && nameWatches.length > 0
        ? nameWatches.filter((w) => scoreCompany(w.query, String(c.after!.company)) >= 0.8).map((w) => w.sub)
        : [];
    const watchers = [...(followers.get(c.subjectKey) ?? []), ...byName];
    if (watchers.length === 0) continue;
    for (const w of watchers) {
      // One line per follower per sentence, however many rows carried it.
      const key = `${w.email}|${c.sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (queued >= MAX_ALERTS_PER_BATCH) {
        // Never silently: an alert dropped here is a person not told.
        console.warn(`[alerts] batch cap ${MAX_ALERTS_PER_BATCH} reached; the rest of this batch is not queued`);
        return;
      }
      await ctx.db.insert("alertQueue", {
        email: w.email,
        subjectKey: c.subjectKey,
        sentence: c.sentence,
        sourceUrl,
        status: "pending",
        createdAt: now,
      });
      queued++;
    }
  }
}
