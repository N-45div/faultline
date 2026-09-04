import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { foldString } from "../engine/canon";
import { findEmployerSites, LAYOFF_STATES } from "./lookup";

// The evidence pack's data plane. The PDF itself is built in packBuild.ts
// (node runtime); this file owns the rows: the request, the gathered versions,
// and the token the download route resolves.

function newToken(): string {
  let t = "";
  for (let i = 0; i < 40; i++) t += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return t;
}

export const request = internalMutation({
  args: {
    subjectKey: v.string(),
    query: v.string(),
    kind: v.union(v.literal("layoff"), v.literal("building")),
    requestedBy: v.string(),
    agentInboxId: v.optional(v.string()),
    messageId: v.optional(v.string()),
    threadId: v.optional(v.string()),
  },
  returns: v.union(v.id("packs"), v.null()),
  handler: async (ctx, a) => {
    // Building the same pack twice for the same person in the same few minutes
    // is never what they meant, whatever the mail said.
    const recent = await ctx.db
      .query("packs")
      .withIndex("by_subject", (q) => q.eq("subjectKey", a.subjectKey).gte("createdAt", Date.now() - 10 * 60_000))
      .collect();
    if (recent.some((p) => p.requestedBy === a.requestedBy && p.status !== "failed")) {
      console.log(`[pack] duplicate request for ${a.query} from ${a.requestedBy}, ignored`);
      return null;
    }
    const packId = await ctx.db.insert("packs", {
      subjectKey: a.subjectKey,
      query: a.query,
      kind: a.kind,
      requestedBy: a.requestedBy,
      agentInboxId: a.agentInboxId,
      messageId: a.messageId,
      threadId: a.threadId,
      downloadToken: newToken(),
      status: "building",
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.packBuild.buildPack, { packId });
    return packId;
  },
});

const observationOut = v.object({
  identityKey: v.string(),
  assertedAt: v.string(),
  capturedAt: v.number(),
  fullHash: v.string(),
  fields: v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null())),
});

export const data = internalQuery({
  args: { packId: v.id("packs") },
  returns: v.any(),
  handler: async (ctx, { packId }) => {
    const pack = await ctx.db.get(packId);
    if (!pack) return null;

    // A layoff pack covers every site the matched employer filed for.
    let keys = [pack.subjectKey];
    if (pack.kind === "layoff") {
      const sites = await findEmployerSites(ctx.db, pack.query);
      if (sites[0] && sites[0].score >= 0.6) {
        const company = foldString(sites[0].company);
        const matched = sites.filter((s) => foldString(s.company) === company).map((s) => s.subjectKey);
        if (matched.includes(pack.subjectKey) || matched.length > 0) keys = matched;
      }
    }

    // Every layoff file we hold, not the two we started with: a pack that
    // silently drops four states is the paid product contradicting the free one.
    const slugs = pack.kind === "layoff" ? Object.keys(LAYOFF_STATES) : ["nyc-hpd"];
    const currents: { sourceSlug: string; fields: Record<string, string | number | boolean | null>; identityKey: string }[] = [];
    const observations: (typeof observationOut.type)[] = [];
    const changes: { detectedAt: number; sentence: string }[] = [];

    for (const slugName of slugs) {
      const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slugName)).unique();
      if (!src) continue;
      for (const key of keys) {
        const cur = await ctx.db
          .query("current")
          .withIndex("by_source_subject", (q) => q.eq("sourceId", src._id).eq("subjectKey", key))
          .collect();
        for (const c of cur) currents.push({ sourceSlug: slugName, fields: c.fields, identityKey: c.identityKey });
      }
    }
    for (const key of keys) {
      if (observations.length >= 400) break;
      const obs = await ctx.db
        .query("observations")
        .withIndex("by_subject_claim", (q) => q.eq("subjectKey", key))
        .take(400 - observations.length);
      for (const o of obs)
        observations.push({ identityKey: o.identityKey, assertedAt: o.assertedAt, capturedAt: o.capturedAt, fullHash: o.fullHash, fields: o.fields });
    }
    for (const key of keys) {
      if (changes.length >= 100) break;
      const ch = await ctx.db
        .query("changes")
        .withIndex("by_subject", (q) => q.eq("subjectKey", key))
        .order("desc")
        .take(100 - changes.length);
      for (const c of ch) changes.push({ detectedAt: c.detectedAt, sentence: c.sentence });
    }

    const subject = await ctx.db
      .query("subjects")
      .withIndex("by_kind_key", (q) => q.eq("kind", pack.kind === "layoff" ? "employer_site" : "building").eq("key", pack.subjectKey))
      .unique();

    const first = await ctx.db.query("snapshots").order("asc").first();
    return {
      pack: {
        token: pack.downloadToken,
        query: pack.query,
        kind: pack.kind,
        agentInboxId: pack.agentInboxId,
        messageId: pack.messageId,
        createdAt: pack.createdAt,
      },
      subjectLabel: subject?.label ?? pack.query,
      currents,
      observations,
      changes,
      firstCapture: first ? new Date(first.capturedAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    };
  },
});

export const ready = internalMutation({
  args: { packId: v.id("packs"), storageId: v.id("_storage"), pages: v.number(), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    // A retry stores a second PDF. Whatever the row pointed at before is now
    // referenced by nothing, and the daily collector only ever deletes ids it
    // finds on a pack row — so it would sit in storage for good.
    const existing = await ctx.db.get(a.packId);
    if (existing?.storageId && existing.storageId !== a.storageId) {
      await ctx.storage.delete(existing.storageId);
      console.warn(`[packs] replaced an earlier PDF for ${a.packId}`);
    }
    await ctx.db.patch(a.packId, { storageId: a.storageId, pages: a.pages, bytes: a.bytes, status: "ready" });
    return null;
  },
});

export const failed = internalMutation({
  args: { packId: v.id("packs") },
  returns: v.null(),
  handler: async (ctx, { packId }) => {
    await ctx.db.patch(packId, { status: "failed" });
    return null;
  },
});

export const byToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({ status: v.string(), storageId: v.optional(v.id("_storage")), query: v.string() }),
  ),
  handler: async (ctx, { token }) => {
    if (token.length < 20) return null;
    const pack = await ctx.db.query("packs").withIndex("by_download_token", (q) => q.eq("downloadToken", token)).unique();
    return pack ? { status: pack.status, storageId: pack.storageId, query: pack.query } : null;
  },
});

/**
 * Thirty days on, the PDF goes and the row says "expired". The receipt it
 * was built from, and every version behind it, stay; a fresh PACK reply
 * builds it again from the same rows. Storage holds versions, not copies.
 */
export const expire = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 86_400_000;
    // The predicate belongs in the query. Taking the oldest 100 and filtering
    // afterwards means that once 100 expired rows exist, every later run takes
    // the same 100, filters them all out, and nothing is ever collected again.
    const old = await ctx.db
      .query("packs")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .filter((q) => q.eq(q.field("status"), "ready"))
      .take(100);
    for (const p of old) {
      if (!p.storageId) continue;
      await ctx.storage.delete(p.storageId);
      await ctx.db.patch(p._id, { storageId: undefined, status: "expired" });
    }
    if (old.length > 0) console.log(`[packs] expired ${old.length}`);
    return old.length;
  },
});
