import { v } from "convex/values";
import { askFrom, askLine, saysFalse, secondWordLine } from "../../engine/hpd";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { groupForWall } from "../../engine/wall";
import { scoreCompany } from "../../engine/match";
import { paused } from "../guard";
const MAX_ALERTS_PER_BATCH = 200;
/** Every active follow is read into memory per batch; this bounds that read. */
/** Followers of one subject, read per subject rather than table-wide. */
const MAX_FOLLOWERS_PER_SUBJECT = 200;
/** Name follows ("tell me if anything appears under Amazon"), read as a group. */
const MAX_NAME_WATCHES = 500;
/** No one person's busy building may consume a whole batch's alerts. */
const MAX_ALERTS_PER_EMAIL_PER_BATCH = 20;

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
/**
 * Two backstops no bug can talk its way past. A source never runs twice
 * inside MIN_GAP_MS, whatever its nextRunAt says — a deferral loop, a manual
 * runNow, a cadence typo. And it never runs more than MAX_RUNS_PER_DAY times
 * in a UTC day. The free plan is a monthly budget; these make the worst day
 * a bounded one.
 */
const MIN_GAP_MS = 20 * 60_000;
const MAX_RUNS_PER_DAY = 30;

export const tick = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    if (paused("ingest")) return 0;
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const due = await ctx.db
      .query("sources")
      .withIndex("by_due", (q) => q.eq("status", "active").lte("nextRunAt", now))
      .take(20);
    let scheduled = 0;
    for (const s of due) {
      if (s.lockedUntil && s.lockedUntil > now) continue;
      if (s.lastRunAt && now - s.lastRunAt < MIN_GAP_MS) continue;
      const runsToday = s.runsDay === today ? (s.runsToday ?? 0) : 0;
      if (runsToday >= MAX_RUNS_PER_DAY) {
        if (runsToday === MAX_RUNS_PER_DAY) console.warn(`[tick] ${s.slug} hit ${MAX_RUNS_PER_DAY} runs today; holding until tomorrow`);
        await ctx.db.patch(s._id, { runsToday: runsToday + 1, nextRunAt: now + 6 * 3_600_000 });
        continue;
      }
      await ctx.db.patch(s._id, { lockedUntil: now + LOCK_MS, runsDay: today, runsToday: runsToday + 1 });
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
 * Every current row of these subjects, hashes only: the "before" side for a
 * slice that is exhaustive per subject, where a row that does not come back
 * for a fetched building has left the file.
 */
export const prevForSubjects = internalQuery({
  args: { sourceId: v.id("sources"), subjectKeys: v.array(v.string()) },
  returns: v.array(v.object({ identityKey: v.string(), sigHash: v.string(), fullHash: v.string() })),
  handler: async (ctx, { sourceId, subjectKeys }) => {
    const out: { identityKey: string; sigHash: string; fullHash: string }[] = [];
    for (const key of subjectKeys) {
      const rows = await ctx.db
        .query("current")
        .withIndex("by_source_subject", (q) => q.eq("sourceId", sourceId).eq("subjectKey", key))
        .take(500);
      for (const r of rows) out.push({ identityKey: r.identityKey, sigHash: r.sigHash, fullHash: r.fullHash });
    }
    return out;
  },
});

/** The stored fields for just the rows the diff found moved or missing. */
export const prevFields = internalQuery({
  args: { sourceId: v.id("sources"), identityKeys: v.array(v.string()) },
  returns: v.array(v.object({ identityKey: v.string(), fields })),
  handler: async (ctx, { sourceId, identityKeys }) => {
    const out: { identityKey: string; fields: Doc<"current">["fields"] }[] = [];
    for (const key of identityKeys) {
      const r = await ctx.db
        .query("current")
        .withIndex("by_source_identity", (q) => q.eq("sourceId", sourceId).eq("identityKey", key))
        .unique();
      if (r) out.push({ identityKey: r.identityKey, fields: r.fields });
    }
    return out;
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
  // source has more current rows than that. Hashes only: the diff decides
  // "unchanged" from the hashes alone, and that is nearly every row of every
  // cycle. Sending each row's whole `fields` back too was ~1.7 MB per New
  // Jersey cycle for bytes the diff never looked at — read `prevFields` for
  // the few keys that actually moved.
  returns: v.array(v.object({ identityKey: v.string(), sigHash: v.string(), fullHash: v.string() })),
  handler: async (ctx, { sourceId, mode, identityKeys }) => {
    const pick = (r: Doc<"current">) => ({ identityKey: r.identityKey, sigHash: r.sigHash, fullHash: r.fullHash });
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
  screenshotStorageId: v.optional(v.id("_storage")),
  firecrawlChangeStatus: v.optional(v.string()),
  firecrawlPreviousScrapeAt: v.optional(v.string()),
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

    // Rows that enter or leave `current` this batch. Kept as a counter on the
    // source so the pages that quote "records we hold" never scan the table.
    let entered = 0;
    let left = 0;
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
        entered++;
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
      if (cur) {
        left++;
        await ctx.db.delete(cur._id);
      }
    }
    // The changelog counters: what the government did to this file since we
    // began holding it. Shadow cycles do not count — the first read of a file
    // is not the state adding two thousand rows.
    const tally = { added: 0, changed: 0, removed: 0 };
    if (emit) for (const c of args.changes) tally[c.kind]++;
    if (entered || left || tally.added || tally.changed || tally.removed)
      await ctx.db.patch(args.sourceId, {
        currentCount: Math.max(0, (source.currentCount ?? 0) + entered - left),
        addedCount: (source.addedCount ?? 0) + tally.added,
        changedCount: (source.changedCount ?? 0) + tally.changed,
        removedCount: (source.removedCount ?? 0) + tally.removed,
      });

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
    /** Forget the stored etag, so the next cycle asks for the whole file again. */
    clearEtag: v.optional(v.boolean()),
    next: v.object({ nextRunAt: v.number(), cursor: v.optional(v.string()), lastStatus: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error("source vanished");
    await ctx.db.patch(args.sourceId, {
      readCount: (source.readCount ?? 0) + 1,
      lastRunAt: args.capturedAt,
      nextRunAt: args.next.nextRunAt,
      cursor: args.next.cursor ?? source.cursor,
      lastStatus: args.next.lastStatus,
      lastEtag: args.clearEtag ? undefined : (args.etag ?? source.lastEtag),
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
  // Followers are looked up per subject this batch actually touched. Reading
  // the whole table and filtering in memory looked cheaper, but the read was
  // capped: past that many rows, whoever sorted late simply stopped being
  // told, silently, and inactive rows spent the budget too.
  const followers = new Map<string, Doc<"subscriptions">[]>();
  for (const key of new Set(changes.map((c) => c.subjectKey))) {
    const rows: Doc<"subscriptions">[] = await ctx.db
      .query("subscriptions")
      .withIndex("by_subject", (q: any) => q.eq("subjectKey", key).eq("active", true))
      .take(MAX_FOLLOWERS_PER_SUBJECT);
    if (rows.length > 0) followers.set(key, rows);
  }
  // A follow on a NAME, not a filing: "tell me if anything appears under
  // Amazon". These have no subject to look up, so they are read as a group —
  // there is no index that finds "every q: key" any other way.
  const nameWatches: { query: string; sub: Doc<"subscriptions"> }[] = [];
  if (changes.some((c) => c.kind === "added")) {
    const watches: Doc<"subscriptions">[] = await ctx.db
      .query("subscriptions")
      .withIndex("by_subject", (q: any) => q.gte("subjectKey", "q:").lt("subjectKey", "q;"))
      .take(MAX_NAME_WATCHES);
    for (const s of watches) if (s.active) nameWatches.push({ query: s.subjectKey.slice(2).replace(/-/g, " "), sub: s });
  }
  // The city's second word. When HPD stamps a certification false or
  // invalid on a violation somebody answered about, their answer gets the
  // city's date beside it, and they hear it unless they have told us to stop.
  await citySecondWord(ctx, changes, sourceUrl);

  if (followers.size === 0 && nameWatches.length === 0) return;

  const now = Date.now();
  let queued = 0;
  const perEmail = new Map<string, number>();
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
      // The cap is per person. Returning here abandoned the rest of the batch
      // for everybody, so one busy building silenced a follower of a quiet
      // employer whose change happened to sort after it — and because the
      // changes commit in this same transaction, that alert was never
      // re-derived.
      const mine = (perEmail.get(w.email) ?? 0) + 1;
      perEmail.set(w.email, mine);
      if (mine > MAX_ALERTS_PER_EMAIL_PER_BATCH) {
        if (mine === MAX_ALERTS_PER_EMAIL_PER_BATCH + 1) console.warn(`[alerts] ${w.email} hit the ${MAX_ALERTS_PER_EMAIL_PER_BATCH}-line cap for this batch`);
        continue;
      }
      if (queued >= MAX_ALERTS_PER_BATCH) {
        // Never silently: an alert dropped here is a person not told.
        console.warn(`[alerts] batch cap ${MAX_ALERTS_PER_BATCH} reached; the rest of this batch is not queued`);
        return;
      }
      // A fixed claim on a housing violation is not news to relay; it is a
      // question for the person who lives there. The line carries the claim
      // so the reply can be matched to it.
      const ask = c.kind !== "removed" && c.after ? askFrom(c.after) : null;
      await ctx.db.insert("alertQueue", {
        email: w.email,
        subjectKey: c.subjectKey,
        sentence: ask ? askLine(ask, String(c.after?.__subjectLabel ?? c.subjectKey)) : c.sentence,
        sourceUrl,
        status: "pending",
        createdAt: now,
        ...(ask ? { ask } : {}),
      });
      queued++;
    }
  }
}

export async function citySecondWord(
  ctx: { db: any },
  changes: { subjectKey: string; kind: "added" | "changed" | "removed"; after?: Record<string, string | number | boolean | null> }[],
  sourceUrl: string,
) {
  const now = Date.now();
  for (const c of changes) {
    if (c.kind === "removed" || !c.after) continue;
    const status = String(c.after.currentstatus ?? "");
    if (!saysFalse(status)) continue;
    const violationId = String(c.after.violationid ?? "");
    if (!violationId) continue;
    const rows: Doc<"attestations">[] = await ctx.db
      .query("attestations")
      .withIndex("by_violation", (q: any) => q.eq("violationId", violationId))
      .take(50);
    const on = String(c.after.currentstatusdate ?? "");
    const where = String(c.after.__subjectLabel ?? c.subjectKey);
    // One line per person per stamp: the first time they said it was still
    // broken, or else their latest word.
    const told = new Map<string, Doc<"attestations">>();
    for (const r of rows) {
      if (r.laterStatus === status) continue;
      await ctx.db.patch(r._id, { laterStatus: status, laterStatusDate: on, laterAt: now });
      if (!r.answer || r.saidAt === undefined) continue;
      const prior = told.get(r.email);
      const better =
        !prior ||
        (r.answer === "still_broken" && (prior.answer !== "still_broken" || r.saidAt < (prior.saidAt ?? 0))) ||
        (prior.answer !== "still_broken" && r.answer !== "still_broken" && r.saidAt > (prior.saidAt ?? 0));
      if (better) told.set(r.email, r);
    }
    for (const r of told.values()) {
      await ctx.db.insert("alertQueue", {
        email: r.email,
        subjectKey: r.subjectKey,
        sentence: secondWordLine({ answer: r.answer!, saidOn: new Date(r.saidAt!).toISOString().slice(0, 10), violationId, where, status, on }),
        sourceUrl,
        status: "pending",
        createdAt: now,
        secondWord: true,
      });
    }
  }
}
