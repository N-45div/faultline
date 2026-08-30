import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
const MAX_ALERTS_PER_COMMIT = 50;

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

/** One fetch cycle, written atomically. */
export const commit = internalMutation({
  args: {
    sourceId: v.id("sources"),
    snapshot: v.object({
      capturedAt: v.number(),
      requestUrl: v.string(),
      httpStatus: v.number(),
      etag: v.optional(v.string()),
      lastModified: v.optional(v.string()),
      bodySha256: v.string(),
      bodyStorageId: v.optional(v.id("_storage")),
      rowCount: v.number(),
      degraded: v.boolean(),
    }),
    /** Only rows that are new or whose full content moved. */
    observations: v.array(
      v.object({
        identityKey: v.string(),
        subject,
        claimKind: v.string(),
        assertedAt: v.string(),
        fields,
        sigHash: v.string(),
        fullHash: v.string(),
      }),
    ),
    changes: v.array(
      v.object({
        identityKey: v.string(),
        subjectKey: v.string(),
        kind: v.union(v.literal("added"), v.literal("changed"), v.literal("removed")),
        changed: v.array(v.string()),
        before: v.optional(fields),
        after: v.optional(fields),
        sentence: v.string(),
      }),
    ),
    sourceUrl: v.string(),
    next: v.object({
      nextRunAt: v.number(),
      cursor: v.optional(v.string()),
      lastStatus: v.string(),
    }),
  },
  returns: v.object({ observations: v.number(), changes: v.number(), emitted: v.boolean() }),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error("source vanished");
    const now = args.snapshot.capturedAt;

    const snapshotId = await ctx.db.insert("snapshots", {
      sourceId: args.sourceId,
      ...args.snapshot,
      pinnedUntil: args.snapshot.bodyStorageId ? now + 14 * 86_400_000 : undefined,
    });

    for (const o of args.observations) {
      await upsertSubject(ctx, o.subject);
      const observationId = await ctx.db.insert("observations", {
        sourceId: args.sourceId,
        snapshotId,
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

    // Removed rows leave `current` so a reappearance reads as "added" again.
    for (const c of args.changes) {
      if (c.kind !== "removed") continue;
      const cur = await ctx.db
        .query("current")
        .withIndex("by_source_identity", (q) => q.eq("sourceId", args.sourceId).eq("identityKey", c.identityKey))
        .unique();
      if (cur) await ctx.db.delete(cur._id);
    }

    const emit = source.emit;
    for (const c of args.changes) {
      const changeId = await ctx.db.insert("changes", {
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
        snapshotId,
      });
      if (emit) await pushToWall(ctx, args.sourceId, changeId, now, c.sentence, args.sourceUrl);
    }

    if (args.changes.length > 0) await bumpPulse(ctx, args.sourceId, now, args.changes.length);
    if (emit && args.changes.length > 0) await notifyFollowers(ctx, args.changes, args.sourceUrl);

    await ctx.db.patch(args.sourceId, {
      lastRunAt: now,
      nextRunAt: args.next.nextRunAt,
      cursor: args.next.cursor ?? source.cursor,
      lastStatus: args.next.lastStatus,
      lastEtag: args.snapshot.etag ?? source.lastEtag,
      lastBodySha256: args.snapshot.bodySha256,
      lockedUntil: undefined,
      consecutiveFailures: 0,
      shadowCycles: emit ? source.shadowCycles : source.shadowCycles + 1,
    });

    return { observations: args.observations.length, changes: args.changes.length, emitted: emit };
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

/** The public wall: bounded per source, trimmed in the same transaction. */
async function pushToWall(ctx: { db: any }, sourceId: Id<"sources">, changeId: Id<"changes">, now: number, sentence: string, sourceUrl: string) {
  await ctx.db.insert("recentChanges", { sourceId, changeId, createdAt: now, sentence, sourceUrl });
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

/** FOLLOW means: email me, in the same thread, when this filing changes. */
async function notifyFollowers(
  ctx: { db: any; scheduler: any },
  changes: { subjectKey: string; sentence: string }[],
  sourceUrl: string,
) {
  const inbox = process.env.AGENTMAIL_INBOX_ID;
  if (!inbox || !process.env.AGENTMAIL_API_KEY) return;
  const bySubject = new Map<string, string[]>();
  for (const c of changes) bySubject.set(c.subjectKey, [...(bySubject.get(c.subjectKey) ?? []), c.sentence]);
  let sent = 0;
  for (const [subjectKey, sentences] of bySubject) {
    const subs: Doc<"subscriptions">[] = await ctx.db
      .query("subscriptions")
      .withIndex("by_subject", (q: any) => q.eq("subjectKey", subjectKey).eq("active", true))
      .collect();
    for (const s of subs) {
      if (sent >= MAX_ALERTS_PER_COMMIT) return;
      const text = ["A filing you follow changed.", "", ...sentences.slice(0, 5), "", `Check it: ${sourceUrl}`, "We kept the version before this one, dated.", "", "Reply STOP to stop."].join(String.fromCharCode(10));
      if (s.messageId) await ctx.scheduler.runAfter(0, internal.mail.reply, { agentInboxId: inbox, parentMessageId: s.messageId, text });
      else await ctx.scheduler.runAfter(0, internal.mail.send, { agentInboxId: inbox, to: s.email, subject: "A filing you follow changed", text });
      sent++;
    }
  }
}
