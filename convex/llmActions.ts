"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { MODEL, PROMPT_VERSION, DAILY_CALL_CAP, costCents, type Usage } from "./llm";
import { paused, providerFault } from "./guard";

// The only file that talks to OpenAI. One job: read a termination letter —
// pasted text or an attached PDF — and pull out what it states, so it can sit
// beside the filing. The instructions below are deliberately long and byte-
// stable: past 1,024 tokens the API caches the prefix, so every letter after
// the first pays the cached input rate. Change them only with PROMPT_VERSION.

const client = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * One zod schema drives both the model's strict output format and our runtime
 * validation of what came back. Strict structured outputs require every field
 * present; absence is expressed as null, never as a missing key.
 */
const Letter = z.object({
  employer: z.string().nullable().describe("The employer's name exactly as written in the letter"),
  location: z.string().nullable().describe("Site, office, facility, or city, if the letter states one"),
  noticeDate: z.string().nullable().describe("The letter's own date, YYYY-MM-DD, only if the year is stated"),
  lastDay: z.string().nullable().describe("Last day of employment or separation effective date, YYYY-MM-DD"),
  statedReason: z.string().nullable().describe("Short paraphrase of the stated reason for the decision"),
  quotedClaim: z.string().nullable().describe("The letter's own sentence giving the reason, copied verbatim"),
  severanceOffered: z.boolean().describe("True only if the letter offers severance pay or a separation package"),
  signDeadlineDays: z.number().int().nullable().describe("Days given to sign a release or agreement, if stated"),
  owbpaDisclosureAttached: z.enum(["yes", "no", "unclear"]).describe("Whether the OWBPA list of job titles and ages is said to be attached"),
  mentionsAgeOver40: z.boolean().describe("True if the letter mentions age 40, ADEA, or OWBPA anywhere"),
  confidence: z.number().describe("0 to 1: how sure you are the extraction is faithful"),
});
export type LetterExtraction = z.infer<typeof Letter>;

/**
 * Byte-stable across every call — this is the cached prefix. It is long on
 * purpose, and every line of it earns its place: the statute table and the
 * OWBPA rules are what let the model recognise half-said things in real
 * letters ("you have 45 days to consider" is an OWBPA group-termination tell).
 */
const INSTRUCTIONS = [
  "You read one termination, layoff, furlough, reduction-in-force, or separation letter, and you extract only what the letter itself states. You are a careful clerk, not a lawyer and not a judge.",
  "",
  "Absolute rules:",
  "- Extract statements, never conclusions. If the letter does not say a thing, the answer is null (or false for booleans). Never fill a field from your general knowledge of a company, an industry, or the news.",
  "- Never infer whether anything is lawful, unlawful, fair, or unfair. No field asks for that, and nothing you write should imply it.",
  "- quotedClaim is the single sentence in the letter that gives the reason for the decision, copied verbatim, including its punctuation. If the reason is spread over two sentences, choose the one that states the cause. If no sentence states a reason, quotedClaim is null.",
  "- statedReason is your short neutral paraphrase of that same reason: 'restructuring', 'position eliminated', 'economic conditions', 'performance', 'facility closure'. If quotedClaim is null, statedReason is null too.",
  "- Dates are YYYY-MM-DD and only when the letter states the year. 'March 14' with no year anywhere in the letter is null. 'March 14, 2026' is 2026-03-14. If the letter is dated in a header ('Dated: ...' or a date line above the salutation), that is noticeDate.",
  "- lastDay is the employee's final day of employment or the separation's effective date, whichever the letter states. 'Your employment will end effective September 30, 2026' means lastDay is 2026-09-30. A paid-through date or benefits-end date is NOT lastDay unless the letter says employment itself ends then.",
  "- severanceOffered is true only for an actual offer of severance pay, separation pay, or a separation package in exchange for something or as a gratuity. Continued health coverage alone, or accrued PTO paid out, is not severance.",
  "- signDeadlineDays: if the letter gives a number of days to review, consider, or sign a release, separation agreement, or waiver, extract that integer. 'You have twenty-one (21) days' is 21. A calendar deadline ('by October 15') with no day count is null.",
  "- confidence is your honest 0-to-1 estimate that every extracted field is faithful to the letter. Scanned or OCR-mangled text lowers it. A clean, complete letter with explicit dates is 0.9 or higher.",
  "",
  "Background you may use to RECOGNISE what the letter is saying (never to fill fields the letter left empty):",
  "",
  "WARN Act notice periods, by jurisdiction. These exist so you can recognise references like 'in accordance with WARN' or 'this letter constitutes notice under the New York State WARN Act':",
  "- Federal WARN: 60 days' written notice, generally for employers of 100+ where 50+ at a site lose employment.",
  "- New York (NY WARN): 90 days, employers of 50+, thresholds lower than federal.",
  "- California (Cal-WARN): 60 days, employers of 75+, covers layoffs of 50+ at a covered establishment.",
  "- New Jersey (NJ WARN / Millville Dallas): 90 days, and mandatory severance of one week per year of service.",
  "- Illinois (IL WARN): 60 days, employers of 75+.",
  "A letter citing any of these is still just a statement — record the dates it gives; the comparison against the statute happens elsewhere, deterministically.",
  "",
  "OWBPA (Older Workers Benefit Protection Act), for the owbpaDisclosureAttached and mentionsAgeOver40 fields:",
  "- When a release of age-discrimination (ADEA) claims is sought from anyone 40 or over, the release must give 21 days to consider (individual termination) or 45 days (group termination or exit-incentive program), plus 7 days to revoke after signing.",
  "- In a GROUP termination, the employer must also attach a written disclosure: the class or unit of employees covered, the eligibility factors, the time limits, and the job titles and ages of all individuals selected and not selected.",
  "- owbpaDisclosureAttached is 'yes' only if the letter says such a list, exhibit, appendix, or disclosure of job titles and ages is attached, enclosed, or provided. It is 'no' if the letter seeks a release from someone the letter shows is 40+ in a group termination and mentions no such list. It is 'unclear' otherwise — including every individual (non-group) termination.",
  "- mentionsAgeOver40 is true if the letter anywhere mentions age 40, the ADEA, the Age Discrimination in Employment Act, or the OWBPA, whether or not a disclosure is attached.",
  "- '45 days to consider' in a letter is a strong sign of a group termination; '21 days' of an individual one. Record the number in signDeadlineDays either way.",
  "",
  "Input handling:",
  "- The letter may arrive as pasted plain text, as forwarded email including headers and reply chains, or as an attached PDF. Ignore email boilerplate, signatures, confidentiality footers, and everything that is not the letter itself.",
  "- If the input contains more than one letter, extract the most recent termination letter and ignore the rest.",
  "- If the input is not a termination, layoff, furlough, or separation letter at all, return null for every nullable field, false for booleans, 'unclear' for owbpaDisclosureAttached, and confidence 0.",
].join("\n");

/** Moderation stops only what should never enter the pipeline. It is free. */
const HARD_CATEGORIES = ["sexual/minors", "harassment/threatening", "hate/threatening", "violence/graphic", "self-harm/intent", "self-harm/instructions"];

interface AttachmentRef {
  agentInboxId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
}

async function downloadAttachment(a: AttachmentRef): Promise<{ base64: string; bytes: number } | null> {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) return null;
  const base = process.env.AGENTMAIL_BASE_URL ?? "https://api.agentmail.to/v0";
  const url = `${base}/inboxes/${encodeURIComponent(a.agentInboxId)}/messages/${encodeURIComponent(a.messageId)}/attachments/${encodeURIComponent(a.attachmentId)}`;
  // The endpoint returns metadata with a signed download_url; the bytes live
  // on the CDN behind it.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`[llm] attachment fetch ${res.status} for ${a.filename}`);
    return null;
  }
  const meta: any = await res.json().catch(() => null);
  if (!meta?.download_url) {
    console.error(`[llm] attachment metadata missing download_url for ${a.filename}`);
    return null;
  }
  const file = await fetch(String(meta.download_url));
  if (!file.ok) {
    console.error(`[llm] attachment download ${file.status} for ${a.filename}`);
    return null;
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > 8_000_000) {
    console.warn(`[llm] attachment ${a.filename} too large (${buf.byteLength} bytes), skipped`);
    return null;
  }
  return { base64: buf.toString("base64"), bytes: buf.byteLength };
}

export const extractLetter = internalAction({
  args: {
    inboxId: v.id("inbox"),
    text: v.string(),
    bodyHash: v.string(),
    attachment: v.optional(
      v.object({
        agentInboxId: v.string(),
        messageId: v.string(),
        attachmentId: v.string(),
        filename: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { inboxId, text, bodyHash, attachment }) => {
    const cached = await ctx.runQuery(internal.llm.cachedExtraction, { bodyHash });
    if (cached) {
      await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text, extraction: cached, note: "cache" });
      return null;
    }
    if (paused("llm") || (await ctx.runQuery(internal.breaker.open, { provider: "openai" }))) {
      console.warn(`[llm] skipped: ${paused("llm") ? "NOTICE_PAUSE" : "openai breaker open"}`);
      await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text, extraction: null, note: "nokey" });
      return null;
    }
    const calls = await ctx.runQuery(internal.llm.callsToday, {});
    if (!process.env.OPENAI_API_KEY || calls >= DAILY_CALL_CAP) {
      console.warn(`[llm] skipped: ${!process.env.OPENAI_API_KEY ? "no key" : `daily cap ${DAILY_CALL_CAP} reached`}`);
      await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text, extraction: null, note: process.env.OPENAI_API_KEY ? "budget" : "nokey" });
      return null;
    }

    const openai = client();
    let extraction: LetterExtraction | null = null;
    let note = "failed";
    try {
      // Free screen on what a stranger mailed us, before the paid call.
      if (text.trim()) {
        const mod = await openai.moderations.create({ model: "omni-moderation-latest", input: text.slice(0, 8_000) });
        const r = mod.results[0];
        const hard = r?.flagged && HARD_CATEGORIES.some((c) => (r.categories as unknown as Record<string, boolean>)[c]);
        if (hard) {
          console.warn(`[llm] moderation stopped a message`);
          await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text: "", extraction: null, note: "moderation" });
          return null;
        }
      }

      const content: Array<
        { type: "input_text"; text: string } | { type: "input_file"; filename: string; file_data: string }
      > = [];
      if (text.trim()) content.push({ type: "input_text", text: text.slice(0, 12_000) });
      if (attachment) {
        const file = await downloadAttachment(attachment);
        if (file) {
          content.push({ type: "input_file", filename: attachment.filename || "letter.pdf", file_data: `data:application/pdf;base64,${file.base64}` });
        }
      }
      if (content.length === 0) throw new Error("nothing to read: empty body and no readable attachment");

      const res = await openai.responses.parse({
        model: MODEL,
        instructions: INSTRUCTIONS,
        input: [{ role: "user", content }],
        max_output_tokens: 800,
        text: { format: zodTextFormat(Letter, "letter") },
        prompt_cache_key: PROMPT_VERSION,
      });
      extraction = res.output_parsed ?? null;
      if (!extraction) throw new Error(`no parsed output (status ${res.status})`);
      note = "live";

      const model = res.model ?? MODEL;
      const u: Usage = {
        input_tokens: res.usage?.input_tokens ?? 0,
        output_tokens: res.usage?.output_tokens ?? 0,
        input_tokens_details: { cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0 },
      };
      const cents = costCents(model, u);
      await ctx.runMutation(internal.llm.recordExtraction, {
        bodyHash,
        model,
        output: extraction,
        inputTokens: u.input_tokens,
        cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: u.output_tokens,
        costCents: cents,
      });
      console.log(`[llm] ${model} in=${u.input_tokens} cached=${u.input_tokens_details?.cached_tokens} out=${u.output_tokens} → ${cents}¢`);
      await ctx.runMutation(internal.breaker.record, { provider: "openai", ok: true });
    } catch (e) {
      console.error(`[llm] failed: ${String(e)}`);
      if (providerFault(e)) await ctx.runMutation(internal.breaker.record, { provider: "openai", ok: false, error: String(e) });
    }
    await ctx.runMutation(internal.inbound.finishLetter, { inboxId, text, extraction, note });
    return null;
  },
});
