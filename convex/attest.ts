import { v } from "convex/values";
import { internalAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { askFrom, askLine } from "../engine/hpd";

// The tenant's word beside the city's. The city's row says the owner
// certified a repair; the person who lives there says whether it happened.
// The two are kept apart, both dated, and neither is edited by the other.

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** The photo a person attached to their answer, fetched from the mail and kept with it. */
export const storePhoto = internalAction({
  args: {
    attestationId: v.id("attestations"),
    attachment: v.object({ agentInboxId: v.string(), messageId: v.string(), attachmentId: v.string(), filename: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, { attestationId, attachment: a }) => {
    const key = process.env.AGENTMAIL_API_KEY;
    if (!key) return null;
    const base = process.env.AGENTMAIL_BASE_URL ?? "https://api.agentmail.to/v0";
    try {
      const meta = await fetch(
        `${base}/inboxes/${encodeURIComponent(a.agentInboxId)}/messages/${encodeURIComponent(a.messageId)}/attachments/${encodeURIComponent(a.attachmentId)}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      if (!meta.ok) throw new Error(`attachment metadata ${meta.status}`);
      const j = (await meta.json()) as { download_url?: string };
      if (!j.download_url) throw new Error("no download_url");
      const file = await fetch(String(j.download_url));
      if (!file.ok) throw new Error(`download ${file.status}`);
      const blob = await file.blob();
      if (blob.size > MAX_PHOTO_BYTES) throw new Error(`photo too large (${blob.size} bytes)`);
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.attest.attachPhoto, { attestationId, storageId });
      console.log(`[attest] photo kept (${blob.size} bytes)`);
    } catch (e) {
      console.error(`[attest] photo not kept: ${String(e)}`);
    }
    return null;
  },
});

export const attachPhoto = internalMutation({
  args: { attestationId: v.id("attestations"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { attestationId, storageId }) => {
    await ctx.db.patch(attestationId, { photoStorageId: storageId });
    return null;
  },
});

const said = v.object({
  violationId: v.string(),
  askedStatus: v.string(),
  askedStatusDate: v.string(),
  certifiedBy: v.union(v.string(), v.null()),
  hazardClass: v.string(),
  description: v.string(),
  answer: v.union(v.literal("fixed"), v.literal("still_broken"), v.literal("not_sure")),
  saidAt: v.number(),
  note: v.optional(v.string()),
  hasPhoto: v.boolean(),
  laterStatus: v.optional(v.string()),
  laterStatusDate: v.optional(v.string()),
});

/**
 * What the people who live in a building said, beside what the city's file
 * says — answers only, newest first. No address of the person, no photo
 * bytes: the photo's existence is a fact; the photo is theirs.
 */
export const forBuilding = query({
  args: { bbl: v.string() },
  returns: v.array(said),
  handler: async (ctx, { bbl }) => {
    const rows = await ctx.db
      .query("attestations")
      .withIndex("by_subject_said", (q) => q.eq("subjectKey", bbl).gte("saidAt", 0))
      .order("desc")
      .take(50);
    return rows
      .filter((r) => r.answer !== undefined && r.saidAt !== undefined)
      .map((r) => ({
        violationId: r.violationId,
        askedStatus: r.askedStatus,
        askedStatusDate: r.askedStatusDate,
        certifiedBy: r.certifiedBy,
        hazardClass: r.hazardClass,
        description: r.description,
        answer: r.answer!,
        saidAt: r.saidAt!,
        note: r.note,
        hasPhoto: r.photoStorageId !== undefined,
        laterStatus: r.laterStatus,
        laterStatusDate: r.laterStatusDate,
      }));
  },
});

/**
 * Ask a follower about the fixed claims already on a building's file — the
 * ones the city stamped before we began asking. Real rows, a real person who
 * follows the building; the digest sends it within the minute, one a day.
 */
export const askNow = internalMutation({
  args: {
    email: v.string(),
    bbl: v.string(),
    max: v.optional(v.number()),
    /** Operator's own address, followed here by the operator's own hand. Never for a stranger. */
    follow: v.optional(v.boolean()),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { email, bbl, max, follow }) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_email", (q) => q.eq("email", email).eq("subjectKey", bbl))
      .unique();
    if (!sub && follow) await ctx.db.insert("subscriptions", { subjectKey: bbl, email, createdAt: Date.now(), active: true, confirmed: true });
    else if (sub && !sub.active && follow) await ctx.db.patch(sub._id, { active: true, confirmed: true });
    else if (!sub || !sub.active) throw new Error(`${email} does not follow ${bbl}`);
    const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-hpd")).unique();
    if (!src) throw new Error("no nyc-hpd source");
    const rows = await ctx.db
      .query("current")
      .withIndex("by_source_subject", (q) => q.eq("sourceId", src._id).eq("subjectKey", bbl))
      .collect();
    const asks = rows
      .map((r) => ({ ask: askFrom(r.fields), label: String(r.fields.__subjectLabel ?? bbl) }))
      .filter((x): x is { ask: NonNullable<ReturnType<typeof askFrom>>; label: string } => x.ask !== null)
      .sort((a, b) => (a.ask.statusDate < b.ask.statusDate ? 1 : -1))
      .slice(0, max ?? 3);
    const now = Date.now();
    for (const { ask, label } of asks) {
      await ctx.db.insert("alertQueue", {
        email,
        subjectKey: bbl,
        sentence: askLine(ask, label),
        sourceUrl: "https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5",
        status: "pending",
        createdAt: now,
        ask,
      });
    }
    return asks.map((a) => `#${a.ask.violationId} ${a.ask.status} ${a.ask.statusDate}`);
  },
});
