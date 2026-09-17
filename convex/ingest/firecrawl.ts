"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { components } from "../_generated/api";
import { FirecrawlClient, type Format } from "@firecrawl/firecrawl-convex";
import { changedLines } from "../../engine/evidence";

// Firecrawl fetches on our behalf from its own infrastructure: the state pages
// this deployment cannot reach, or that only fill in once their own scripts
// run. For those it can also return two pieces of evidence — a screenshot of
// the page as it was served, and Firecrawl's own change tracking against its
// previous capture, with the lines it saw move — so every read carries a
// second reading of the page beside our diff, whether or not the two agree.

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
  /** The lines Firecrawl saw move since its previous capture, cut from its git-diff. */
  changeDiff?: string;
};

export type Found = { url: string; title: string; description: string };

/**
 * What the open web says about a name, through Firecrawl's search. We take the
 * addresses and nothing else: the words a person reads come from the page we
 * then hold ourselves, hashed and dated, not from a result summary that no one
 * can check later.
 */
export async function searchWeb(ctx: { runAction: any }, query: string, opts: { limit?: number; excludeDomains?: string[] } = {}): Promise<Found[]> {
  const res = await firecrawl.search(ctx as Parameters<FirecrawlClient["search"]>[0], query.slice(0, 300), {
    sources: ["web"],
    limit: Math.min(Math.max(opts.limit ?? 5, 1), 10),
    timeout: 45_000,
    ...(opts.excludeDomains?.length ? { excludeDomains: opts.excludeDomains } : {}),
  });
  const rows = (res.web ?? []) as Array<Record<string, any>>;
  return rows
    .map((r) => ({
      url: String(r.url ?? r.metadata?.sourceURL ?? ""),
      title: String(r.title ?? r.metadata?.title ?? "").slice(0, 120),
      description: String(r.description ?? r.metadata?.description ?? "").slice(0, 200),
    }))
    .filter((r) => /^https?:\/\//.test(r.url));
}

/** One page, as HTML and markdown, and when asked, a screenshot and Firecrawl's own change tracking. Throws on a non-2xx from the target. */
export async function scrapePage(ctx: { runAction: any }, url: string, opts: { waitForMs?: number; evidence?: boolean } = {}): Promise<Scraped> {
  const formats: Format[] = ["html", "markdown"];
  // One tag for all our captures, so Firecrawl compares each read with its
  // previous capture for us. That is usually our last commit but not always: a
  // read that fails after Firecrawl captured the page still counts, so the
  // commit page prints the time Firecrawl compared against.
  if (opts.evidence) formats.push({ type: "changeTracking", tag: "faultline", modes: ["git-diff"] }, { type: "screenshot", fullPage: true });
  // The client only needs runAction; the ingest loop passes a narrower ctx.
  const doc = await firecrawl.scrape(ctx as Parameters<FirecrawlClient["scrape"]>[0], url, {
    formats,
    onlyMainContent: false,
    timeout: 60_000 + (opts.waitForMs ?? 0),
    ...(opts.waitForMs ? { waitFor: opts.waitForMs } : {}),
  });
  const status = Number(doc.metadata?.statusCode ?? 200);
  if (doc.metadata?.error || status >= 400) throw new Error(`Firecrawl: ${doc.metadata?.error ?? `HTTP ${status}`} from ${url}`);
  const tracked = (doc.changeTracking ?? {}) as { changeStatus?: unknown; previousScrapeAt?: unknown; diff?: { text?: unknown } };
  const moved = typeof tracked.diff?.text === "string" ? changedLines(tracked.diff.text) : "";
  return {
    status,
    url: String(doc.metadata?.sourceURL ?? url),
    html: doc.html ?? doc.rawHtml ?? "",
    markdown: doc.markdown ?? "",
    credits: Number(doc.metadata?.creditsUsed ?? 1),
    ...(typeof doc.screenshot === "string" ? { screenshotUrl: doc.screenshot } : {}),
    ...(typeof tracked.changeStatus === "string" ? { changeStatus: tracked.changeStatus } : {}),
    ...(typeof tracked.previousScrapeAt === "string" ? { previousScrapeAt: tracked.previousScrapeAt } : {}),
    ...(moved ? { changeDiff: moved } : {}),
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
