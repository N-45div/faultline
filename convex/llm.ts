import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { AGENT_DAILY_CAP, limits } from "./limits";

export { AGENT_DAILY_CAP };

// The model's ledger and cache. The calls themselves live in llmActions.ts
// (node runtime, official SDK); this file is the part the database owns: every
// call keyed by the letter's content hash so a re-forwarded letter costs
// nothing, and every call priced in cents at the moment it was made.

export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
export const PROMPT_VERSION = "letter-v3";
export const DAILY_CALL_CAP = 60;
/** The inbox agent: GPT-6 Astra through the OpenAI Agents SDK, with tools. */
export const AGENT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-6-astra";

/** USD per 1M tokens. Configured, not fetched — correct here if the dashboard disagrees. */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  // developers.openai.com/api/docs/models/gpt-6-astra, standard short context, Sep 14 2026.
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "gpt-5.4-mini": { input: 0.25, cached: 0.025, output: 2.0 },
  "gpt-5.4-nano": { input: 0.05, cached: 0.005, output: 0.4 },
};

export type Usage = { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };

export function costCents(model: string, u: Usage): number {
  const p = PRICES[model];
  // A model with no configured price is logged at zero, never at another model's price.
  if (!p) return 0;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const usd = ((u.input_tokens - cached) * p.input + cached * p.cached + u.output_tokens * p.output) / 1_000_000;
  return Math.round(usd * 100 * 10_000) / 10_000;
}

export const cachedExtraction = internalQuery({
  args: { bodyHash: v.string() },
  returns: v.any(),
  handler: async (ctx, { bodyHash }) => {
    const rows = await ctx.db.query("extractions").withIndex("by_body_sha", (q) => q.eq("bodySha256", bodyHash)).collect();
    const hit = rows.find((r) => r.promptVersion === PROMPT_VERSION);
    return hit ? hit.output : null;
  },
});

export const callsToday = internalQuery({
  args: { purpose: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { purpose }) => {
    const start = Date.now() - 86_400_000;
    const rows = await ctx.db.query("llmUsage").withIndex("by_created", (q) => q.gte("createdAt", start)).collect();
    // Letters only. Counting corroboration here meant a burst of public search
    // calls could take letter-reading — the thing people actually email us
    // for — offline for a day.
    // The agent has its own count for the same reason.
    return rows.filter((r) => (purpose ? r.purpose === purpose : r.purpose === "letter")).length;
  },
});

export const recordExtraction = internalMutation({
  args: {
    bodyHash: v.string(),
    model: v.string(),
    output: v.any(),
    inputTokens: v.number(),
    cachedTokens: v.number(),
    outputTokens: v.number(),
    costCents: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const now = Date.now();
    await ctx.db.insert("extractions", { bodySha256: a.bodyHash, model: a.model, output: a.output, createdAt: now, promptVersion: PROMPT_VERSION, costCents: a.costCents });
    await ctx.db.insert("llmUsage", { model: a.model, purpose: "letter", inputTokens: a.inputTokens, cachedTokens: a.cachedTokens, outputTokens: a.outputTokens, costCents: a.costCents, createdAt: now });
    return null;
  },
});

/** The ledger, in cents. */
export const usage = internalQuery({
  args: {},
  returns: v.object({ calls: v.number(), cents: v.number(), callsToday: v.number(), centsToday: v.number(), cacheHits: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("llmUsage").collect();
    const dayAgo = Date.now() - 86_400_000;
    const today = rows.filter((r) => r.createdAt >= dayAgo);
    const sum = (rs: typeof rows) => Math.round(rs.reduce((n, r) => n + r.costCents, 0) * 10_000) / 10_000;
    const extractions = await ctx.db.query("extractions").collect();
    const letters = await ctx.db.query("inbox").withIndex("by_thread").collect();
    const letterCount = letters.filter((r) => r.intent === "letter").length;
    return { calls: rows.length, cents: sum(rows), callsToday: today.length, centsToday: sum(today), cacheHits: Math.max(0, letterCount - extractions.length) };
  },
});

/** One model call that is not a letter extraction: the agent's runs. */
/** One run of the inbox agent, if the day has room for it. */
export const allowAgentRun = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => (await limits.limit(ctx, "agentRun")).ok,
});

export const recordUsage = internalMutation({
  args: {
    model: v.string(),
    purpose: v.string(),
    inputTokens: v.number(),
    cachedTokens: v.number(),
    outputTokens: v.number(),
    costCents: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    await ctx.db.insert("llmUsage", { ...a, createdAt: Date.now() });
    return null;
  },
});
