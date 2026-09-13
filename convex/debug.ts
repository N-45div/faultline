import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { TableNames } from "./_generated/dataModel";
import { handleInbound } from "./inbound";
import { groupForWall } from "../engine/wall";

// Dev-only. Never exposed publicly.

export const overview = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    // Bounded, and low: these rows carry their whole `fields` object, so even
    // a few thousand of them across a dozen tables blows the 16 MiB read limit
    // — and this is the thing you reach for when something is already wrong.
    // Exact totals live on the source rows; this is a shape check.
    const CAP = 200;
    const count = async (t: TableNames) => {
      const rows = await ctx.db.query(t).take(CAP + 1);
      return rows.length > CAP ? `${CAP.toLocaleString()}+` : rows.length;
    };
    const latest = await ctx.db.query("changes").order("desc").take(6);
    const snaps = await ctx.db.query("snapshots").order("desc").take(6);
    return {
      sources: await count("sources"),
      targets: await count("targets"),
      subjects: await count("subjects"),
      snapshots: await count("snapshots"),
      observations: await count("observations"),
      current: await count("current"),
      changes: await count("changes"),
      recentChanges: await count("recentChanges"),
      inbox: await count("inbox"),
      receipts: await count("receipts"),
      subscriptions: await count("subscriptions"),
      latestChanges: latest.map((c) => `${c.kind} · ${c.sentence}`),
      latestSnapshots: snaps.map((s) => `${s.httpStatus} rows=${s.rowCount} degraded=${s.degraded} pinned=${Boolean(s.bodyStorageId)}`),
    };
  },
});

/** Replays an inbound email through the real handler without AgentMail. */
export const simulateInbound = internalMutation({
  args: { from: v.string(), subject: v.string(), text: v.optional(v.string()), threadId: v.optional(v.string()), agentInboxId: v.optional(v.string()) },
  returns: v.object({ intent: v.string(), query: v.string(), kind: v.string(), sent: v.boolean(), text: v.string(), pending: v.optional(v.boolean()) }),
  handler: async (ctx, { from, subject, text, threadId, agentInboxId }) => {
    const id = `sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const r = await handleInbound(
      ctx,
      {
        message_id: id,
        thread_id: threadId ?? `simthread-${id}`,
        inbox_id: agentInboxId ?? "",
        from,
        subject,
        text: text ?? "",
        timestamp: new Date().toISOString(),
      },
      true,
    );
    return { intent: r.intent, query: r.query, kind: r.kind, sent: r.sent, text: r.text, pending: r.pending };
  },
});

/**
 * Rewinds rows so the next fetch of a source sees them as changed. This is how
 * the alert path is proven end to end without waiting for a city to act: the
 * held version is made stale, the real file is read again, and the difference
 * between them is a real diff over real bytes.
 */
export const forceChange = internalMutation({
  args: { slug: v.string(), rows: v.number(), field: v.string(), value: v.string(), subjectKey: v.optional(v.string()) },
  returns: v.object({ rewound: v.number(), subjectKeys: v.array(v.string()) }),
  handler: async (ctx, { slug, rows, field, value, subjectKey }) => {
    const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!src) throw new Error(`no source ${slug}`);
    const current = subjectKey
      ? await ctx.db
          .query("current")
          .withIndex("by_source_subject", (q) => q.eq("sourceId", src._id).eq("subjectKey", subjectKey))
          .take(Math.min(rows, 25))
      : await ctx.db
          .query("current")
          .withIndex("by_source_identity", (q) => q.eq("sourceId", src._id))
          .take(Math.min(rows, 25));
    const subjectKeys: string[] = [];
    for (const c of current) {
      await ctx.db.patch(c._id, {
        fields: { ...c.fields, [field]: value },
        sigHash: `rewound-${c.sigHash.slice(0, 8)}`,
        fullHash: `rewound-${c.fullHash.slice(0, 8)}`,
      });
      if (!subjectKeys.includes(c.subjectKey)) subjectKeys.push(c.subjectKey);
    }
    await ctx.db.patch(src._id, { nextRunAt: 0, lockedUntil: undefined /* dev only: forceChange runs against a quiet source */ });
    return { rewound: current.length, subjectKeys };
  },
});

/** Empties the public wall. It is a cache of `changes`; nothing is lost. */
export const clearWall = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("recentChanges").take(500);
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});

/**
 * Rebuilds the public wall from the changes we actually recorded, grouped the
 * way ingest now groups them. The wall is a cache; the changes are the truth.
 */
export const rebuildWall = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const old = await ctx.db.query("recentChanges").take(500);
    for (const r of old) await ctx.db.delete(r._id);
    const sources = await ctx.db.query("sources").collect();
    let written = 0;
    for (const s of sources) {
      const changes = await ctx.db
        .query("changes")
        .withIndex("by_source_emit", (q) => q.eq("sourceId", s._id).eq("emit", true))
        .order("desc")
        .take(200);
      // One cycle at a time, so a building's nine rows from one read group.
      const byCycle = new Map<number, typeof changes>();
      for (const c of changes) byCycle.set(c.detectedAt, [...(byCycle.get(c.detectedAt) ?? []), c]);
      const sourceUrl = old.find((o) => o.sourceId === s._id)?.sourceUrl ?? "";
      let onWall = 0;
      for (const [at, cycle] of [...byCycle.entries()].sort((a, b) => b[0] - a[0])) {
        if (onWall >= 50) break;
        const rows = groupForWall(cycle.map((c) => ({ kind: c.kind, subjectKey: c.subjectKey, before: c.before, after: c.after, sentence: c.sentence })));
        for (const row of rows) {
          if (onWall >= 50) break;
          await ctx.db.insert("recentChanges", {
            sourceId: s._id,
            changeId: cycle[row.first]._id,
            createdAt: at,
            sentence: row.sentence,
            sourceUrl,
            subjectKey: row.subjectKey,
            count: row.count,
            weight: row.weight,
          });
          onWall++;
          written++;
        }
      }
    }
    return written;
  },
});

/** Row counts for sources whose last read was a 304, from their last full read. */
export const backfillRowCounts = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let n = 0;
    for (const s of await ctx.db.query("sources").collect()) {
      const snaps = await ctx.db
        .query("snapshots")
        .withIndex("by_source_captured", (q) => q.eq("sourceId", s._id))
        .order("desc")
        .take(50);
      const full = snaps.find((x) => x.httpStatus !== 304 && x.rowCount > 0);
      if (full && s.rowCount !== full.rowCount) {
        await ctx.db.patch(s._id, { rowCount: full.rowCount });
        n++;
      }
    }
    return n;
  },
});

/**
 * One-off, run in batches until it returns 0: free the slice bodies pinned
 * before 4 September for server-filtered sources. Those bytes were our own
 * composed JSON, never the state's file, and every row in them is still held
 * as an observation. `npx convex run --prod debug:unpinSliceBodies`
 */
export const unpinSliceBodies = internalMutation({
  args: { batch: v.optional(v.number()) },
  returns: v.object({ freed: v.number(), remaining: v.boolean() }),
  handler: async (ctx, { batch }) => {
    const n = Math.min(batch ?? 100, 200);
    const slices = ["nyc-hpd", "nyc-restaurants"];
    let freed = 0;
    for (const slug of slices) {
      const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
      if (!src) continue;
      const snaps = await ctx.db
        .query("snapshots")
        .withIndex("by_source_captured", (q) => q.eq("sourceId", src._id))
        .filter((q) => q.neq(q.field("bodyStorageId"), undefined))
        .take(n - freed);
      for (const snap of snaps) {
        if (!snap.bodyStorageId) continue;
        // A database import carries the row but not the file behind it, so
        // the id may point at nothing. Clearing the reference is the point.
        try {
          await ctx.storage.delete(snap.bodyStorageId);
        } catch {
          /* already gone */
        }
        await ctx.db.patch(snap._id, { bodyStorageId: undefined });
        freed++;
      }
      if (freed >= n) break;
    }
    return { freed, remaining: freed >= n };
  },
});

/** One-off after the read counter was added: seed it from the snapshots on file. */
export const backfillReadCounts = internalMutation({
  args: {},
  returns: v.array(v.object({ slug: v.string(), reads: v.number() })),
  handler: async (ctx) => {
    const out: { slug: string; reads: number }[] = [];
    for (const src of await ctx.db.query("sources").collect()) {
      const snaps = await ctx.db.query("snapshots").withIndex("by_source_captured", (q) => q.eq("sourceId", src._id)).take(5000);
      await ctx.db.patch(src._id, { readCount: snaps.length });
      out.push({ slug: src.slug, reads: snaps.length });
    }
    return out;
  },
});

/**
 * One-off after the current counter was added: count what each source holds,
 * a page at a time, and store it. Reads every current row once.
 */
export const backfillCurrentCounts = internalMutation({
  args: { slug: v.string(), cursor: v.optional(v.string()), soFar: v.optional(v.number()) },
  returns: v.object({ slug: v.string(), count: v.number(), done: v.boolean(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { slug, cursor, soFar }) => {
    const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!src) throw new Error(`no source ${slug}`);
    const page = await ctx.db
      .query("current")
      .withIndex("by_source_identity", (q) => q.eq("sourceId", src._id))
      .paginate({ cursor: cursor ?? null, numItems: 1000 });
    const count = (soFar ?? 0) + page.page.length;
    if (page.isDone) await ctx.db.patch(src._id, { currentCount: count });
    return { slug, count, done: page.isDone, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** One-off after the changelog counters were added: count emitted changes per source, a page at a time. */
export const backfillChangeCounts = internalMutation({
  args: { slug: v.string(), cursor: v.optional(v.string()), added: v.optional(v.number()), changed: v.optional(v.number()), removed: v.optional(v.number()) },
  returns: v.object({ slug: v.string(), added: v.number(), changed: v.number(), removed: v.number(), done: v.boolean(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { slug, cursor, added, changed, removed }) => {
    const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!src) throw new Error(`no source ${slug}`);
    const page = await ctx.db
      .query("changes")
      .withIndex("by_source_emit", (q) => q.eq("sourceId", src._id).eq("emit", true))
      .paginate({ cursor: cursor ?? null, numItems: 1000 });
    const t = { added: added ?? 0, changed: changed ?? 0, removed: removed ?? 0 };
    for (const c of page.page) t[c.kind]++;
    if (page.isDone) await ctx.db.patch(src._id, { addedCount: t.added, changedCount: t.changed, removedCount: t.removed });
    return { slug, ...t, done: page.isDone, cursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * One-off: delete "changed" events whose list of changed fields is empty —
 * the phantom edits a definition change produced before the diff engine
 * learned to treat them as silent. Run per source until done.
 */
export const purgePhantomEdits = internalMutation({
  args: { slug: v.string(), cursor: v.optional(v.string()), purged: v.optional(v.number()) },
  returns: v.object({ slug: v.string(), purged: v.number(), done: v.boolean(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { slug, cursor, purged }) => {
    const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!src) throw new Error(`no source ${slug}`);
    const page = await ctx.db
      .query("changes")
      .withIndex("by_source_emit", (q) => q.eq("sourceId", src._id))
      .paginate({ cursor: cursor ?? null, numItems: 500 });
    let n = purged ?? 0;
    for (const c of page.page) {
      if (c.kind !== "changed" || c.changed.length !== 0) continue;
      await ctx.db.delete(c._id);
      n++;
    }
    return { slug, purged: n, done: page.isDone, cursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * One-off: delete the "changed" events of one commit whose bytes are the
 * same as the read before it. Identical bytes mean the state changed
 * nothing, so every "edit" on that commit came from our side — an adapter
 * re-sorting ordinals, a date format — and is withdrawn. Refuses to touch a
 * commit whose bytes actually differ from the read before.
 */
export const purgeArtefactEdits = internalMutation({
  args: { snapshotId: v.id("snapshots") },
  returns: v.object({ purged: v.number(), hash: v.string(), previousHash: v.string() }),
  handler: async (ctx, { snapshotId }) => {
    const snap = await ctx.db.get(snapshotId);
    if (!snap) throw new Error("no such snapshot");
    const before = await ctx.db
      .query("snapshots")
      .withIndex("by_source_captured", (q) => q.eq("sourceId", snap.sourceId).lt("capturedAt", snap.capturedAt))
      .order("desc")
      .filter((q) => q.neq(q.field("httpStatus"), 304))
      .first();
    if (!before) throw new Error("no earlier read to compare against");
    if (before.bodySha256 !== snap.bodySha256)
      throw new Error(`bytes differ from the read before (${before.bodySha256.slice(0, 12)} vs ${snap.bodySha256.slice(0, 12)}); not an artefact`);
    const rows = await ctx.db.query("changes").withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId)).take(2000);
    let purged = 0;
    for (const c of rows) {
      if (c.kind !== "changed") continue;
      await ctx.db.delete(c._id);
      purged++;
    }
    return { purged, hash: snap.bodySha256.slice(0, 12), previousHash: before.bodySha256.slice(0, 12) };
  },
});

/**
 * After a live test of the tenant loop from the operator's own test inbox:
 * remove that address's follow, queued lines and answers, so no real
 * building carries a test answer as if a tenant had given it.
 */
export const forgetTester = internalMutation({
  args: { email: v.string(), subjectKeys: v.optional(v.array(v.string())) },
  returns: v.object({ subscriptions: v.number(), alerts: v.number(), attestations: v.number() }),
  handler: async (ctx, { email, subjectKeys }) => {
    const only = subjectKeys ? new Set(subjectKeys) : null;
    let subscriptions = 0;
    for (const s of await ctx.db.query("subscriptions").withIndex("by_email", (q) => q.eq("email", email)).collect()) {
      if (only && !only.has(s.subjectKey)) continue;
      await ctx.db.delete(s._id);
      subscriptions++;
    }
    let alerts = 0;
    for (const status of ["pending", "sent"] as const) {
      for (const a of await ctx.db.query("alertQueue").withIndex("by_email_status", (q) => q.eq("email", email).eq("status", status)).take(500)) {
        if (only && !only.has(a.subjectKey)) continue;
        await ctx.db.delete(a._id);
        alerts++;
      }
    }
    let attestations = 0;
    for (const a of await ctx.db.query("attestations").withIndex("by_email_asked", (q) => q.eq("email", email)).take(500)) {
      if (a.photoStorageId) await ctx.storage.delete(a.photoStorageId);
      await ctx.db.delete(a._id);
      attestations++;
    }
    return { subscriptions, alerts, attestations };
  },
});
