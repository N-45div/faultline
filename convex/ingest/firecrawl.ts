"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { components } from "../_generated/api";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";

// Firecrawl fetches on our behalf from their infrastructure. Two jobs, both
// real: states whose pages this deployment cannot reach or cannot parse from
// raw bytes, and an employer's press page captured once, at the moment a
// filing appears, so the words we quote are words we hold.

const firecrawl = new FirecrawlClient(components.firecrawl);

export type Scraped = { status: number; url: string; html: string; markdown: string; credits: number };

/** One page, as HTML and markdown. Throws on a non-2xx from the target. */
export async function scrapePage(ctx: { runAction: any }, url: string): Promise<Scraped> {
  // The client only needs runAction; the ingest loop passes a narrower ctx.
  const doc = await firecrawl.scrape(ctx as Parameters<FirecrawlClient["scrape"]>[0], url, { formats: ["html", "markdown"], onlyMainContent: false, timeout: 60_000 });
  const status = Number(doc.metadata?.statusCode ?? 200);
  if (doc.metadata?.error || status >= 400) throw new Error(`Firecrawl: ${doc.metadata?.error ?? `HTTP ${status}`} from ${url}`);
  return {
    status,
    url: String(doc.metadata?.sourceURL ?? url),
    html: doc.html ?? doc.rawHtml ?? "",
    markdown: doc.markdown ?? "",
    credits: Number(doc.metadata?.creditsUsed ?? 1),
  };
}

/**
 * Dev-only: read a page through Firecrawl and show the first part of it.
 * Internal, so nobody but the deployment owner can spend a credit with it.
 */
export const probe = internalAction({
  args: { url: v.string(), chars: v.optional(v.number()), format: v.optional(v.union(v.literal("markdown"), v.literal("html"))), offset: v.optional(v.number()) },
  returns: v.object({ status: v.number(), url: v.string(), htmlBytes: v.number(), markdownBytes: v.number(), credits: v.number(), head: v.string() }),
  handler: async (ctx, { url, chars, format, offset }) => {
    const s = await scrapePage(ctx, url);
    const text = format === "html" ? s.html : s.markdown;
    return {
      status: s.status,
      url: s.url,
      htmlBytes: s.html.length,
      markdownBytes: s.markdown.length,
      credits: s.credits,
      head: text.slice(offset ?? 0, (offset ?? 0) + (chars ?? 3000)),
    };
  },
});
