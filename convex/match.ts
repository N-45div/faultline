import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Which repair a person is talking about, checked against their own words.
 *
 * The model reads the message and picks a violation number; the tool that
 * records an answer already refuses a number this person was never asked
 * about. That leaves one mistake it cannot catch: two open questions on the
 * same building, and the model picks the wrong one of them. Nothing in the
 * numbers would look wrong, and a tenant's answer would sit on a repair they
 * were not describing.
 *
 * So the condition we asked about is embedded when we ask, and the person's
 * own sentence is embedded when they answer. Convex's vector index says which
 * question their words are nearest. If that is not the one the model chose,
 * and it is not close, nothing is recorded: they are asked which repair they
 * mean, with both conditions in the city's words.
 *
 * Every failure here falls through to recording the model's choice. A person's
 * answer is never lost because an embedding could not be fetched.
 */

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";
/** Matches the vectorIndex in schema.ts. Changing one means changing both. */
const DIMENSIONS = 1536;
/** USD per 1M tokens, developers.openai.com/api/docs/models, Sep 2026. */
const EMBED_PRICE = 0.02;

/**
 * How much nearer another question has to be before we stop and ask. Cosine
 * similarity on normalised embeddings, so this is a gap in similarity, not a
 * percentage: below it the two conditions are close enough that asking would
 * be noise, above it the words are plainly about the other one.
 */
const MARGIN = 0.1;

async function embed(text: string): Promise<{ vector: number[]; tokens: number } | null> {
  const key = process.env.OPENAI_API_KEY;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 1_200);
  if (!key || clean.length < 3) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: clean, dimensions: DIMENSIONS }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    const data: any = await res.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== DIMENSIONS) throw new Error("no embedding in the reply");
    return { vector, tokens: Number(data?.usage?.total_tokens ?? 0) };
  } catch (e) {
    console.warn(`[match] embedding failed: ${String(e)}`);
    return null;
  }
}

/** An embedding costs little, and little is not nothing: it goes in the ledger too. */
async function price(ctx: { runMutation: (ref: any, args: any) => Promise<any> }, tokens: number) {
  await ctx.runMutation(internal.llm.recordUsage, {
    model: EMBED_MODEL,
    purpose: "match",
    inputTokens: tokens,
    cachedTokens: 0,
    outputTokens: 0,
    costCents: Math.round(((tokens * EMBED_PRICE) / 1_000_000) * 100 * 10_000) / 10_000,
  });
}

/** Remember what we asked this person, in a form their words can be compared with. */
export const remember = internalAction({
  args: { email: v.string(), items: v.array(v.object({ violationId: v.string(), text: v.string() })) },
  returns: v.null(),
  handler: async (ctx, { email, items }) => {
    for (const item of items.slice(0, 10)) {
      const held: boolean = await ctx.runQuery(internal.match.have, { email, violationId: item.violationId });
      if (held) continue;
      const got = await embed(item.text);
      if (!got) return null;
      await ctx.runMutation(internal.match.save, {
        email,
        violationId: item.violationId,
        text: item.text.slice(0, 400),
        embedding: got.vector,
      });
      await price(ctx, got.tokens);
    }
    return null;
  },
});

export const have = internalQuery({
  args: { email: v.string(), violationId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { email, violationId }) => {
    const row = await ctx.db
      .query("questionVectors")
      .withIndex("by_email_violation", (q) => q.eq("email", email).eq("violationId", violationId))
      .first();
    return row !== null;
  },
});

export const save = internalMutation({
  args: { email: v.string(), violationId: v.string(), text: v.string(), embedding: v.array(v.float64()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("questionVectors")
      .withIndex("by_email_violation", (q) => q.eq("email", a.email).eq("violationId", a.violationId))
      .first();
    if (row) await ctx.db.patch(row._id, { embedding: a.embedding, text: a.text, at: Date.now() });
    else await ctx.db.insert("questionVectors", { ...a, at: Date.now() });
    return null;
  },
});

/** The rows behind vector-search results, in the order the search returned them. */
export const byIds = internalQuery({
  args: { ids: v.array(v.id("questionVectors")) },
  returns: v.array(v.object({ id: v.id("questionVectors"), violationId: v.string(), text: v.string() })),
  handler: async (ctx, { ids }) => {
    const out = [];
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row) out.push({ id, violationId: row.violationId, text: row.text });
    }
    return out;
  },
});

/**
 * An answer with no number, and more than one repair waiting. The keyword
 * reader used to take the newest of them; their own words take it now, and
 * where the words do not single one out, nothing is recorded and they are
 * asked which - with the city's description of each, so the choice is theirs.
 */
export const answerByWords = internalAction({
  args: {
    inboxId: v.id("inbox"),
    answer: v.union(v.literal("fixed"), v.literal("still_broken"), v.literal("not_sure")),
    note: v.string(),
    words: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, a): Promise<string> => {
    const who: { email: string } | null = await ctx.runQuery(internal.inbound.agentWriter, { inboxId: a.inboxId });
    const waiting: string[] = await ctx.runQuery(internal.inbound.agentOpenViolations, { inboxId: a.inboxId });
    const said = who ? await embed(a.words) : null;
    if (said) await price(ctx, said.tokens);
    const nearest = said && who ? await nearestOf(ctx, who.email, said.vector, waiting) : null;
    if (!nearest) {
      return await ctx.runMutation(internal.inbound.agentClarify, { inboxId: a.inboxId, what: "violation" });
    }
    console.log(`[match] the words are nearest #${nearest}; recording there`);
    return await ctx.runMutation(internal.inbound.agentRecordAnswer, {
      inboxId: a.inboxId,
      violationId: nearest,
      answer: a.answer,
      note: a.note.length > 0 ? a.note : null,
    });
  },
});

/** The one question these words are about, or null if they do not say. */
async function nearestOf(ctx: any, email: string, vector: number[], waiting: string[]): Promise<string | null> {
  if (waiting.length === 0) return null;
  const hits = await ctx.vectorSearch("questionVectors", "by_words", {
    vector,
    filter: (q: any) => q.eq("email", email),
    limit: 8,
  });
  const rows: { id: Id<"questionVectors">; violationId: string; text: string }[] = await ctx.runQuery(internal.match.byIds, {
    ids: hits.map((h: any) => h._id),
  });
  const open = hits
    .map((h: any) => {
      const row = rows.find((r) => r.id === h._id);
      return row && waiting.includes(row.violationId) ? { violationId: row.violationId, score: h._score as number } : null;
    })
    .filter((r: unknown): r is { violationId: string; score: number } => r !== null);
  if (open.length === 0) return null;
  // One clear winner, or none: a person who wrote "still broken" and nothing
  // else has not told us which repair, and should be asked rather than guessed.
  if (open.length > 1 && open[0].score - open[1].score <= MARGIN) return null;
  return open[0].violationId;
}

/**
 * Record the answer the model chose, unless this person's own words are
 * plainly about a different repair we asked them about.
 */
export const recordChecked = internalAction({
  args: {
    inboxId: v.id("inbox"),
    violationId: v.string(),
    answer: v.union(v.literal("fixed"), v.literal("still_broken"), v.literal("not_sure")),
    note: v.union(v.string(), v.null()),
    words: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, a): Promise<string> => {
    const who: { email: string } | null = await ctx.runQuery(internal.inbound.agentWriter, { inboxId: a.inboxId });
    const chosen = a.violationId.replace(/\D/g, "");
    const said = await embed(a.words);
    if (said) await price(ctx, said.tokens);
    if (who && said && chosen) {
      const hits = await ctx.vectorSearch("questionVectors", "by_words", {
        vector: said.vector,
        filter: (q) => q.eq("email", who.email),
        limit: 4,
      });
      const rows: { id: Id<"questionVectors">; violationId: string; text: string }[] = await ctx.runQuery(internal.match.byIds, {
        ids: hits.map((h) => h._id),
      });
      // A row can go between the search and the read, so each score is taken
      // by id and never by position.
      const scored = hits
        .map((h) => {
          const row = rows.find((r) => r.id === h._id);
          return row ? { ...row, score: h._score } : null;
        })
        .filter((r): r is { id: Id<"questionVectors">; violationId: string; text: string; score: number } => r !== null);
      const best = scored[0];
      const mine = scored.find((r) => r.violationId === chosen);
      // Only when we hold the words for both: an old question with no
      // embedding, or a first answer, has nothing to disagree with.
      if (best && mine && best.violationId !== chosen && best.score - mine.score > MARGIN) {
        console.log(`[match] the words are nearer #${best.violationId} than #${chosen} (${best.score.toFixed(3)} against ${mine.score.toFixed(3)}); asking which`);
        return await ctx.runMutation(internal.inbound.agentAskWhichOfTwo, {
          inboxId: a.inboxId,
          violationIds: [best.violationId, chosen],
        });
      }
    }
    return await ctx.runMutation(internal.inbound.agentRecordAnswer, {
      inboxId: a.inboxId,
      violationId: a.violationId,
      answer: a.answer,
      note: a.note,
    });
  },
});
