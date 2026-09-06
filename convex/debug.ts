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
