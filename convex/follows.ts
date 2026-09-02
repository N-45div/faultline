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
    await ctx.db.insert("subscriptions", { subjectKey, email, createdAt: Date.now(), active: true });
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
      out.push({ subjectKey: s.subjectKey, label: subject?.label ?? s.subjectKey, kind: subject?.kind ?? "unknown", since: s.createdAt });
    }
    return out.sort((a, b) => b.since - a.since);
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
