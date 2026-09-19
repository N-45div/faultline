import { v } from "convex/values";
import { internalAction, internalMutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { askFrom, askLine, challengeDeadline, CITY_SAYS_FALSE, type Ask } from "../engine/hpd";
import { isWeb } from "../engine/web";

// The tenant's word beside the city's. The city's row says the owner
// certified a repair; the person who lives with it says whether it happened.
// The two are kept apart, both dated, and neither is edited by the other.
// A person's words are theirs: they are read back on their own page, behind a
// link only they were sent, and reach a public page only once the city's own
// record agrees with them — and even then without the words themselves.

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export function siteBase(): string {
  return (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
}

/**
 * Each claim put to a person becomes a row waiting for their word, dated from
 * the moment it was asked. Asking again about the same unanswered claim does
 * not make a second row.
 */
export async function recordAsks(ctx: MutationCtx, email: string, subjectKey: string, asks: Ask[], now: number): Promise<void> {
  // What a question is about, in words, so a person's own sentence can be
  // matched against it later and not only against its number.
  const fresh: { violationId: string; text: string }[] = [];
  for (const a of asks) {
    const last = await ctx.db
      .query("attestations")
      .withIndex("by_email_violation", (q) => q.eq("email", email).eq("violationId", a.violationId))
      .order("desc")
      .first();
    if (last && last.answer === undefined && last.askedStatus === a.status) continue;
    await ctx.db.insert("attestations", {
      email,
      subjectKey,
      violationId: a.violationId,
      askedAt: now,
      askedStatus: a.status,
      askedStatusDate: a.statusDate,
      certifiedBy: a.certifiedBy,
      hazardClass: a.hazardClass,
      description: a.description,
    });
    if (a.description) fresh.push({ violationId: a.violationId, text: a.description });
  }
  if (fresh.length > 0 && (email.includes("@") || isWeb(email))) {
    await ctx.scheduler.runAfter(0, internal.match.remember, { email, items: fresh.slice(0, 10) });
  }
  // Someone is now waiting on this building's record: whatever else we have
  // stopped watching, the city's second word about it must still reach us.
  if (asks.length > 0) await keepWatching(ctx, subjectKey);
}

async function keepWatching(ctx: MutationCtx, bbl: string) {
  const hpd = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-hpd")).unique();
  if (!hpd) return;
  const t = await ctx.db.query("targets").withIndex("by_source_subject", (q) => q.eq("sourceId", hpd._id).eq("subjectKey", bbl)).unique();
  if (!t) await ctx.db.insert("targets", { sourceId: hpd._id, subjectKey: bbl, active: true, addedBy: "case" });
  else if (!t.active) await ctx.db.patch(t._id, { active: true });
}

function newToken(): string {
  let t = "";
  for (let i = 0; i < 40; i++) t += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return t;
}

/** One unguessable link per address, made the first time it is needed. */
export async function recordToken(ctx: MutationCtx, email: string): Promise<string> {
  const existing = await ctx.db.query("records").withIndex("by_email", (q) => q.eq("email", email)).first();
  if (existing) return existing.token;
  const token = newToken();
  await ctx.db.insert("records", { email, token, createdAt: Date.now() });
  return token;
}

/** The city's rows we hold for one building, as their fields. */
export async function heldForBuilding(ctx: MutationCtx, bbl: string): Promise<Doc<"current">["fields"][]> {
  const hpd = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-hpd")).unique();
  if (!hpd) return [];
  const rows = await ctx.db
    .query("current")
    .withIndex("by_source_subject", (q) => q.eq("sourceId", hpd._id).eq("subjectKey", bbl))
    .take(1000);
  return rows.map((r) => r.fields);
}

export function recordUrl(token: string): string {
  return `${siteBase()}/r/${token}`;
}

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

const answerValidator = v.union(v.literal("fixed"), v.literal("still_broken"), v.literal("not_sure"));

/**
 * The building page's share of the answers: none of their words, and only the
 * ones the city later agreed with — someone said a certified repair was still
 * broken, and afterwards HPD stamped that certification FALSE or INVALID.
 * Before that, an answer is one person's word about a real building, and it
 * stays on that person's own page.
 */
export const corroborated = query({
  args: { bbl: v.string() },
  returns: v.object({
    kept: v.number(),
    rows: v.array(
      v.object({
        violationId: v.string(),
        hazardClass: v.string(),
        description: v.string(),
        saidOn: v.string(),
        laterStatus: v.string(),
        laterStatusDate: v.string(),
      }),
    ),
  }),
  handler: async (ctx, { bbl }) => {
    const answered = await ctx.db
      .query("attestations")
      .withIndex("by_subject_said", (q) => q.eq("subjectKey", bbl).gt("saidAt", 0))
      .take(500);
    // Anyone can open a browser trial and say anything in it. What is said
    // there is kept on the trial's own page, and is never a tenant's word on a
    // public one: not in this count, and not beside the city's stamp.
    const tenants = answered.filter((r) => !isWeb(r.email));
    const people = new Set(tenants.map((r) => `${r.email}|${r.violationId}`));
    const first = new Map<string, Doc<"attestations">>();
    for (const r of tenants) {
      if (r.answer !== "still_broken" || !r.laterStatus || !CITY_SAYS_FALSE.has(r.laterStatus)) continue;
      if (r.saidAt === undefined || r.laterAt === undefined || r.saidAt >= r.laterAt) continue;
      const seen = first.get(r.violationId);
      if (!seen || r.saidAt < (seen.saidAt ?? 0)) first.set(r.violationId, r);
    }
    return {
      kept: people.size,
      rows: [...first.values()]
        .sort((a, b) => (b.laterAt ?? 0) - (a.laterAt ?? 0))
        .map((r) => ({
          violationId: r.violationId,
          hazardClass: r.hazardClass,
          description: r.description,
          saidOn: new Date(r.saidAt ?? 0).toISOString().slice(0, 10),
          laterStatus: r.laterStatus ?? "",
          laterStatusDate: r.laterStatusDate ?? "",
        })),
    };
  },
});

/**
 * A person's own page, opened by the link in their email: every claim they
 * were asked about, what the city's file said then and says now, and every
 * answer they gave, each dated, with their note and their photo.
 */
export const record = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      since: v.number(),
      items: v.array(
        v.object({
          id: v.string(),
          violationId: v.string(),
          subjectKey: v.string(),
          where: v.string(),
          hazardClass: v.string(),
          description: v.string(),
          askedAt: v.number(),
          askedStatus: v.string(),
          askedStatusDate: v.string(),
          certifiedBy: v.union(v.string(), v.null()),
          deadline: v.union(v.string(), v.null()),
          answer: v.optional(answerValidator),
          saidAt: v.optional(v.number()),
          note: v.optional(v.string()),
          photoUrl: v.optional(v.string()),
          laterStatus: v.optional(v.string()),
          laterStatusDate: v.optional(v.string()),
          nowStatus: v.optional(v.string()),
          nowStatusDate: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, { token }) => {
    if (token.length < 20) return null;
    const rec = await ctx.db.query("records").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (!rec) return null;
    const rows = await ctx.db
      .query("attestations")
      .withIndex("by_email_asked", (q) => q.eq("email", rec.email))
      .order("desc")
      .take(100);
    const hpd = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-hpd")).unique();
    const labels = new Map<string, string>();
    const items = [];
    for (const r of rows) {
      let where = labels.get(r.subjectKey);
      if (where === undefined) {
        const s = await ctx.db
          .query("subjects")
          .withIndex("by_kind_key", (q) => q.eq("kind", "building").eq("key", r.subjectKey))
          .unique();
        where = s?.label ?? r.subjectKey;
        labels.set(r.subjectKey, where);
      }
      const cur = hpd
        ? await ctx.db
            .query("current")
            .withIndex("by_source_identity", (q) => q.eq("sourceId", hpd._id).eq("identityKey", `${r.subjectKey}/${r.violationId}`))
            .unique()
        : null;
      const photoUrl = r.photoStorageId ? await ctx.storage.getUrl(r.photoStorageId) : null;
      items.push({
        id: String(r._id),
        violationId: r.violationId,
        subjectKey: r.subjectKey,
        where,
        hazardClass: r.hazardClass,
        description: r.description,
        askedAt: r.askedAt,
        askedStatus: r.askedStatus,
        askedStatusDate: r.askedStatusDate,
        certifiedBy: r.certifiedBy,
        deadline: challengeDeadline({
          violationId: r.violationId,
          status: r.askedStatus,
          statusDate: r.askedStatusDate,
          certifiedBy: r.certifiedBy,
          hazardClass: r.hazardClass,
          description: r.description,
        }),
        ...(r.answer ? { answer: r.answer } : {}),
        ...(r.saidAt !== undefined ? { saidAt: r.saidAt } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(photoUrl ? { photoUrl } : {}),
        ...(r.laterStatus ? { laterStatus: r.laterStatus, laterStatusDate: r.laterStatusDate ?? "" } : {}),
        ...(cur ? { nowStatus: String(cur.fields.currentstatus ?? ""), nowStatusDate: String(cur.fields.currentstatusdate ?? "") } : {}),
      });
    }
    return { since: rec.createdAt, items };
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

/** A reply AgentMail has not accepted after this long was not sent: the send failed, or mail was paused. */
const UNSENT_AFTER_MS = 15 * 60_000;

/**
 * Our replies to this person, newest first, with what became of each: the
 * latest AgentMail event for the message, or "texted" for a reply sent by
 * Photon. A reply AgentMail accepted before its delivery events reached us
 * (15 September) has no event and never will, so it is "accepted", not left
 * waiting for a report. Opened by the same private link as the record.
 */
export const deliveries = query({
  args: { token: v.string() },
  returns: v.array(v.object({ at: v.number(), headline: v.string(), status: v.string(), error: v.union(v.string(), v.null()) })),
  handler: async (ctx, { token }) => {
    if (token.length < 20) return [];
    const rec = await ctx.db.query("records").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (!rec) return [];
    const inbound = await ctx.db
      .query("inbox")
      .withIndex("by_from", (q) => q.eq("fromAddress", rec.email))
      .order("desc")
      .take(15);
    const out: { at: number; headline: string; status: string; error: string | null }[] = [];
    for (const m of inbound) {
      if (!m.threadId) continue;
      const inThread = await ctx.db.query("receipts").withIndex("by_thread", (q) => q.eq("threadId", m.threadId)).take(50);
      const r = inThread.find((x) => x.inboxId === m._id);
      if (!r) continue;
      out.push({
        at: r.createdAt,
        headline: r.text.split("\n")[0].slice(0, 160),
        status:
          r.deliveryStatus ??
          (m.inboxId === "photon" ? "texted" : m.inboxId === "web" ? "shown" : r.outboundId ? "accepted" : Date.now() - r.createdAt > UNSENT_AFTER_MS ? "unsent" : "queued"),
        error: null,
      });
    }
    return out.slice(0, 10);
  },
});
