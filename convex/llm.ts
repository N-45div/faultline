import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// The only place a model is called. One job: read a pasted letter and pull out
// what it states, so it can sit beside the filing. Every call is keyed by the
// letter's content hash, so the same letter forwarded twice costs nothing the
// second time, and every call is priced in cents before it is stored.

export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
export const PROMPT_VERSION = "letter-v1";
const DAILY_CALL_CAP = 60;

/** USD per 1M tokens. Configured, not fetched — correct here if the dashboard disagrees. */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5.4-mini": { input: 0.25, cached: 0.025, output: 2.0 },
  "gpt-5.4-nano": { input: 0.05, cached: 0.005, output: 0.4 },
};

type Usage = { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };

export function costCents(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES[MODEL] ?? PRICES["gpt-5.6-luna"];
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const usd = ((u.input_tokens - cached) * p.input + cached * p.cached + u.output_tokens * p.output) / 1_000_000;
  return Math.round(usd * 100 * 10_000) / 10_000;
}

const SYSTEM = [
  "You read a termination, layoff, or separation letter and extract only what it states.",
  "Use null for anything the letter does not say. Never infer whether anything is lawful.",
  "quotedClaim is the letter's own sentence giving the reason for the decision, verbatim.",
  "Dates are YYYY-MM-DD when the year is stated; otherwise null.",
  "owbpaDisclosureAttached is 'yes' only if the letter says a list of job titles and ages of those selected and not selected is attached or enclosed.",
].join(" ");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "employer", "location", "noticeDate", "lastDay", "statedReason", "quotedClaim",
    "severanceOffered", "signDeadlineDays", "owbpaDisclosureAttached", "mentionsAgeOver40", "confidence",
  ],
  properties: {
    employer: { type: ["string", "null"], description: "The employer's name as written" },
    location: { type: ["string", "null"], description: "Site, office, or city if stated" },
    noticeDate: { type: ["string", "null"] },
    lastDay: { type: ["string", "null"], description: "Last day of employment or effective date" },
    statedReason: { type: ["string", "null"], description: "Short paraphrase of the stated reason" },
    quotedClaim: { type: ["string", "null"] },
    severanceOffered: { type: "boolean" },
    signDeadlineDays: { type: ["integer", "null"], description: "Days given to sign a release, if stated" },
    owbpaDisclosureAttached: { type: "string", enum: ["yes", "no", "unclear"] },
    mentionsAgeOver40: { type: "boolean" },
    confidence: { type: "number", description: "0 to 1" },
  },
};

export const extractLetter = internalAction({
  args: { inboxId: v.id("inbox"), text: v.string(), bodyHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { inboxId, text, bodyHash }) => {
    const cached = await ctx.runQuery(internal.llm.cachedExtraction, { bodyHash });
    if (cached) {
      await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text, extraction: cached, note: "cache" });
      return null;
    }
    const key = process.env.OPENAI_API_KEY;
    const calls = await ctx.runQuery(internal.llm.callsToday, {});
    if (!key || calls >= DAILY_CALL_CAP) {
      console.warn(`[llm] skipped: ${!key ? "no key" : `daily cap ${DAILY_CALL_CAP} reached`}`);
      await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text, extraction: null, note: key ? "budget" : "nokey" });
      return null;
    }

    let extraction: unknown = null;
    try {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL,
          // Static instructions first so the prefix is cacheable across letters.
          input: [
            { role: "system", content: SYSTEM },
            { role: "user", content: text.slice(0, 12_000) },
          ],
          max_output_tokens: 400,
          text: { format: { type: "json_schema", name: "letter", strict: true, schema: SCHEMA } },
        }),
      });
      const d: any = await res.json();
      if (!res.ok || d.error) throw new Error(d.error?.message ?? `HTTP ${res.status}`);
      const raw: string | undefined =
        d.output_text ?? d.output?.flatMap((o: any) => o.content ?? []).find((c: any) => typeof c.text === "string")?.text;
      if (!raw) throw new Error("no output text");
      extraction = JSON.parse(raw);
      const model = d.model ?? MODEL;
      const cents = costCents(model, d.usage);
      await ctx.runMutation(internal.llm.recordExtraction, {
        bodyHash,
        model,
        output: extraction,
        inputTokens: d.usage?.input_tokens ?? 0,
        cachedTokens: d.usage?.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: d.usage?.output_tokens ?? 0,
        costCents: cents,
      });
      console.log(`[llm] ${model} in=${d.usage?.input_tokens} cached=${d.usage?.input_tokens_details?.cached_tokens ?? 0} out=${d.usage?.output_tokens} → ${cents}¢`);
    } catch (e) {
      console.error(`[llm] failed: ${String(e)}`);
    }
    await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text, extraction, note: extraction ? "live" : "failed" });
    return null;
  },
});

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
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const start = Date.now() - 86_400_000;
    const rows = await ctx.db.query("llmUsage").withIndex("by_created", (q) => q.gte("createdAt", start)).collect();
    return rows.length;
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
