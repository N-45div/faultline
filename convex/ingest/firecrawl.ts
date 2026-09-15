"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { components } from "../_generated/api";
import { FirecrawlClient, type Format } from "@firecrawl/firecrawl-convex";

// Firecrawl fetches on our behalf from its own infrastructure: the state pages
// this deployment cannot reach, or that only fill in once their own scripts
// run. For those it can also return two pieces of evidence — a screenshot of
// the page as it was served, and Firecrawl's own change tracking against its
// previous capture — so a read that changed something carries a second
// witness beside our diff.

const firecrawl = new FirecrawlClient(components.firecrawl);

export type Scraped = {
  status: number;
  url: string;
  html: string;
  markdown: string;
  credits: number;
  screenshotUrl?: string;
  changeStatus?: string;
  previousScrapeAt?: string;
};

/** One page, as HTML and markdown, and when asked, a screenshot and Firecrawl's own change tracking. Throws on a non-2xx from the target. */
export async function scrapePage(ctx: { runAction: any }, url: string, opts: { waitForMs?: number; evidence?: boolean } = {}): Promise<Scraped> {
  const formats: Format[] = ["html", "markdown"];
  // One tag for every capture, so "changed" always means changed since our last read.
  if (opts.evidence) formats.push({ type: "changeTracking", tag: "faultline" }, { type: "screenshot", fullPage: true });
  // The client only needs runAction; the ingest loop passes a narrower ctx.
  const doc = await firecrawl.scrape(ctx as Parameters<FirecrawlClient["scrape"]>[0], url, {
    formats,
    onlyMainContent: false,
    timeout: 60_000 + (opts.waitForMs ?? 0),
    ...(opts.waitForMs ? { waitFor: opts.waitForMs } : {}),
  });
  const status = Number(doc.metadata?.statusCode ?? 200);
  if (doc.metadata?.error || status >= 400) throw new Error(`Firecrawl: ${doc.metadata?.error ?? `HTTP ${status}`} from ${url}`);
  const tracked = (doc.changeTracking ?? {}) as { changeStatus?: unknown; previousScrapeAt?: unknown };
  return {
    status,
    url: String(doc.metadata?.sourceURL ?? url),
    html: doc.html ?? doc.rawHtml ?? "",
    markdown: doc.markdown ?? "",
    credits: Number(doc.metadata?.creditsUsed ?? 1),
    ...(typeof doc.screenshot === "string" ? { screenshotUrl: doc.screenshot } : {}),
    ...(typeof tracked.changeStatus === "string" ? { changeStatus: tracked.changeStatus } : {}),
    ...(typeof tracked.previousScrapeAt === "string" ? { previousScrapeAt: tracked.previousScrapeAt } : {}),
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
