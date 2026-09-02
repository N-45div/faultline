"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { MODEL, costCents, type Usage } from "./llm";
import { paused } from "./guard";

// The state's file says a company laid people off, and why. This asks what the
// company was saying in public the same week, and puts the two side by side —
// with links, because the reader has to be able to check it themselves.
//
// Two calls, deliberately. The search call returns prose with citation offsets
// that index into that prose; forcing a JSON schema onto the same call would
// point those offsets into raw JSON and make them useless. So: search first,
// then read the result into a schema with a second, cheap, tool-free call.

const SEARCH_CALL_CENTS = 1; // $10 per 1,000 calls, flat.
const DAILY_SEARCH_CAP = 40;

const Corroboration = z.object({
  corroborated: z.boolean().describe("True only if the search results contain the employer's own public words about this workforce reduction"),
  statementDate: z.string().nullable().describe("YYYY-MM-DD the statement was made or published, if stated"),
  employerStatement: z.string().nullable().describe("The employer's own words, quoted from the search results, at most 300 characters"),
  speakerOrOutlet: z.string().nullable().describe("Who said it, or which publication carried it"),
  confidence: z.enum(["high", "medium", "low"]),
});

/**
 * Named explicitly, and used on the runQuery below: without it TypeScript
 * infers this action's type through the generated api and back into itself,
 * gives up, and quietly types the whole api as `any` — which shows up as
 * errors in unrelated React files.
 */
interface Corroborated {
  corroborated: boolean;
  statementDate: string | null;
  employerStatement: string | null;
  speakerOrOutlet: string | null;
  confidence: string;
  citations: { url: string; title: string }[];
}

export const check = action({
  args: { employer: v.string(), filingDate: v.string(), statedReason: v.optional(v.string()), subjectKey: v.optional(v.string()) },
  returns: v.union(
    // "We couldn't find it" and "we didn't look" are different answers, and
    // the page must never say the first when the truth is the second.
    v.object({ state: v.union(v.literal("budget"), v.literal("off"), v.literal("failed")) }),
    v.object({
      state: v.union(v.literal("found"), v.literal("none")),
      corroborated: v.boolean(),
      statementDate: v.union(v.string(), v.null()),
      employerStatement: v.union(v.string(), v.null()),
      speakerOrOutlet: v.union(v.string(), v.null()),
      confidence: v.string(),
      citations: v.array(v.object({ url: v.string(), title: v.string() })),
      cached: v.boolean(),
    }),
  ),
  handler: async (
    ctx,
    { employer, filingDate, statedReason, subjectKey },
  ): Promise<{ state: "budget" | "off" | "failed" } | (Corroborated & { state: "found" | "none"; cached: boolean })> => {
    const hit: Corroborated | null = await ctx.runQuery(internal.corroborateData.cached, { employer, filingDate });
    if (hit) return { ...hit, state: hit.corroborated ? "found" : "none", cached: true };
    if (!process.env.OPENAI_API_KEY) return { state: "off" };
    if (paused("llm") || (await ctx.runQuery(internal.breaker.open, { provider: "openai" }))) return { state: "off" };
    // Only for a filing we hold. Anyone can call this; only the page's own
    // employer + notice date pairs cost money.
    const known: boolean = await ctx.runQuery(internal.corroborateData.isFiling, { employer, filingDate });
    if (!known) {
      console.warn(`[corroborate] refused: not a filing we hold (${employer.slice(0, 60)} / ${filingDate})`);
      return { state: "failed" };
    }

    const spent = await ctx.runQuery(internal.corroborateData.callsToday, {});
    if (spent >= DAILY_SEARCH_CAP) {
      console.warn(`[corroborate] daily cap ${DAILY_SEARCH_CAP} reached`);
      return { state: "budget" };
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    try {
      // One search. Pinned, because with tool_choice "auto" the model is free
      // to answer from memory, and an answer from memory is worth nothing here.
      // Cast: the API accepts max_tool_calls (verified against the live
      // endpoint) but openai@7.8's request type does not carry it yet.
      const search: any = await openai.responses.create({
        model: MODEL,
        tools: [{ type: "web_search", search_context_size: "low" } as any],
        tool_choice: { type: "web_search" } as any,
        // luna reasons before it writes, and reasoning spends output tokens.
        // At 900 it searched nine times and never got to the answer; the whole
        // call came back empty and still cost nine search fees.
        max_output_tokens: 3000,
        reasoning: { effort: "low" },
        max_tool_calls: 3,
        input: [
          {
            role: "user",
            content:
              `${employer} filed a layoff notice with the state dated ${filingDate}` +
              `${statedReason ? `, giving the reason "${statedReason}"` : ""}.` +
              ` Search for what ${employer} itself said in public between one month before and one month after ${filingDate} about this workforce reduction,` +
              ` its performance, or its plans — a press release, an investor call, a company statement quoted in the local press, or an executive's public remarks.` +
              ` Quote the company's own words and give the date and the source. If you cannot find the company's own words from that window, say so plainly and do not substitute an analyst's or a reporter's characterisation.`,
          },
        ],
      } as any);

      const message: any = (search.output ?? []).find((o: any) => o.type === "message");
      const part: any = message?.content?.find((c: any) => c.type === "output_text");
      const text: string = part?.text ?? search.output_text ?? "";
      const citations = ((part?.annotations ?? []) as any[])
        .filter((a) => a?.type === "url_citation" && a.url)
        // A citation with an empty title renders as an invisible link, and the
        // whole point is that the reader can click it.
        .map((a) => ({ url: String(a.url), title: String(a.title || "").trim() || hostOf(String(a.url)) }))
        .filter((c, i, all) => all.findIndex((o) => o.url === c.url) === i)
        .slice(0, 6);

      // Billed per search the model actually made, not per call we made.
      const searches = (search.output ?? []).filter((o: any) => o.type === "web_search_call").length;
      let cents = SEARCH_CALL_CENTS * Math.max(1, searches) + costCents(search.model ?? MODEL, usageOf(search));

      // No citations means the search found nothing it could stand behind.
      if (!text.trim() || citations.length === 0) {
        const empty = {
          corroborated: false,
          statementDate: null,
          employerStatement: null,
          speakerOrOutlet: null,
          confidence: "low",
          citations: [],
        };
        await ctx.runMutation(internal.corroborateData.record, { employer, filingDate, subjectKey, ...empty, costCents: cents });
        return { ...empty, state: "none", cached: false };
      }

      // Second call: no tools, so the schema is free to be strict.
      const read = await openai.responses.parse({
        model: MODEL,
        instructions:
          "You are given the results of a web search about an employer's public statements around a layoff filing. Extract only what the text supports. " +
          "employerStatement must be the employer's own words, quoted from the text — never a reporter's or an analyst's paraphrase. " +
          "If the text contains no statement from the employer itself, corroborated is false and every other field is null.",
        input: [{ role: "user", content: text.slice(0, 8_000) }],
        max_output_tokens: 500,
        text: { format: zodTextFormat(Corroboration, "corroboration") },
        prompt_cache_key: "corroborate-v1",
      });
      cents += costCents(read.model ?? MODEL, usageOf(read));

      const parsed = read.output_parsed;
      const out = {
        corroborated: Boolean(parsed?.corroborated),
        statementDate: parsed?.statementDate ?? null,
        employerStatement: parsed?.employerStatement ?? null,
        speakerOrOutlet: parsed?.speakerOrOutlet ?? null,
        confidence: parsed?.confidence ?? "low",
        citations,
      };
      await ctx.runMutation(internal.corroborateData.record, { employer, filingDate, subjectKey, ...out, costCents: cents });
      console.log(`[corroborate] ${employer} ${filingDate} → ${out.corroborated ? "corroborated" : "nothing found"}, ${citations.length} citations, ${cents.toFixed(3)}¢`);
      await ctx.runMutation(internal.breaker.record, { provider: "openai", ok: true });
      return { ...out, state: out.corroborated ? "found" : "none", cached: false };
    } catch (e) {
      console.error(`[corroborate] failed: ${String(e)}`);
      await ctx.runMutation(internal.breaker.record, { provider: "openai", ok: false, error: String(e) });
      return { state: "failed" };
    }
  },
});

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

function usageOf(res: { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }): Usage {
  return {
    input_tokens: res.usage?.input_tokens ?? 0,
    output_tokens: res.usage?.output_tokens ?? 0,
    input_tokens_details: { cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0 },
  };
}
