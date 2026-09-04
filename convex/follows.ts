import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// FOLLOW from the web. By email it needs a thread; here it needs a signed-in
// person, whose address goes into the same subscriptions table the inbox uses.
// A change then reaches them through the same one-a-day digest, in a fresh
// email, because there is no thread to reply into.

async function emailOf(ctx: { db: any; auth: any }): Promise<string | null> {
  const userId = await getAuthUserId(ctx as any);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  const email = user?.email ? String(user.email).trim().toLowerCase() : "";
  return email || null;
}

const MAX_FOLLOWS = 500;

export const follow = mutation({
  args: { subjectKey: v.string(), label: v.string() },
  returns: v.union(v.literal("following"), v.literal("sign-in")),
  handler: async (ctx, { subjectKey, label }) => {
    const email = await emailOf(ctx);
    if (!email) return "sign-in";
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_email", (q) => q.eq("email", email).eq("subjectKey", subjectKey))
      .unique();
    if (existing) {
      if (!existing.active) await ctx.db.patch(existing._id, { active: true });
      return "following";
    }
    // A signed-in person can follow as much as they like, up to a ceiling that
    // exists so one account cannot fill the table. Nobody watching filings for
    // a living needs more than this, and the digest is one email a day either
    // way.
    const held = await ctx.db
      .query("subscriptions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(MAX_FOLLOWS + 1);
    if (held.filter((s) => s.active).length >= MAX_FOLLOWS) {
      console.warn(`[follows] ${email} is at the ${MAX_FOLLOWS} ceiling`);
      return "following";
    }
    // Confirmed only if this address has written to us: sign-up does not
    // verify an address, so a web follow alone is not evidence that the person
    // typing it owns it.
    const wroteToUs = await ctx.db.query("inbox").withIndex("by_from", (q) => q.eq("fromAddress", email)).first();
    await ctx.db.insert("subscriptions", { subjectKey, email, createdAt: Date.now(), active: true, confirmed: Boolean(wroteToUs) });
    console.log(`[follows] ${email} now follows ${label}`);
    return "following";
  },
});

export const unfollow = mutation({
  args: { subjectKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { subjectKey }) => {
    const email = await emailOf(ctx);
    if (!email) return null;
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_email", (q) => q.eq("email", email).eq("subjectKey", subjectKey))
      .unique();
    if (existing?.active) await ctx.db.patch(existing._id, { active: false });
    return null;
  },
});

/** Whether the deployment holds a Google client; the button exists only then. */
export const googleEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async () => Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
});

/** Who is signed in, for the bar. Null when nobody is. */
export const me = query({
  args: {},
  returns: v.union(v.null(), v.object({ email: v.string() })),
  handler: async (ctx) => {
    const email = await emailOf(ctx);
    return email ? { email } : null;
  },
});

/** Everything the signed-in person follows, with a label to show. */
export const mine = query({
  args: {},
  returns: v.array(v.object({ subjectKey: v.string(), label: v.string(), kind: v.string(), since: v.number() })),
  handler: async (ctx) => {
    const email = await emailOf(ctx);
    if (!email) return [];
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    const out: { subjectKey: string; label: string; kind: string; since: number }[] = [];
    for (const s of subs) {
      if (!s.active) continue;
      const subject =
        (await ctx.db.query("subjects").withIndex("by_kind_key", (q) => q.eq("kind", "employer_site").eq("key", s.subjectKey)).unique()) ??
        (await ctx.db.query("subjects").withIndex("by_kind_key", (q) => q.eq("kind", "building").eq("key", s.subjectKey)).unique());
      // A follow on a name that has never appeared has no subject row: the key
      // is "q:<the name>". Showing that key raw put an internal noun in front
      // of a reader and linked to a page that says "we couldn't find q acme".
      if (s.subjectKey.startsWith("q:")) {
        const name = s.subjectKey.slice(2).replace(/-/g, " ");
        out.push({ subjectKey: s.subjectKey, label: `${name} — nothing filed yet`, kind: "query", since: s.createdAt });
        continue;
      }
      out.push({ subjectKey: s.subjectKey, label: subject?.label ?? s.subjectKey, kind: subject?.kind ?? "unknown", since: s.createdAt });
    }
    return out.sort((a, b) => b.since - a.since);
  },
});

/**
 * Whether this person's address has ever written to the inbox — the only way
 * we know it is theirs, and so the condition for emailing them at all.
 */
export const emailConfirmed = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const email = await emailOf(ctx);
    if (!email) return false;
    return Boolean(await ctx.db.query("inbox").withIndex("by_from", (q) => q.eq("fromAddress", email)).first());
  },
});

/** Is this signed-in person following this subject? */
export const following = query({
  args: { subjectKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { subjectKey }) => {
    const email = await emailOf(ctx);
    if (!email) return false;
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_email", (q) => q.eq("email", email).eq("subjectKey", subjectKey))
      .unique();
    return Boolean(existing?.active);
  },
});
