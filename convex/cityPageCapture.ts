"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "../engine/canon";
import { cityQuery } from "../engine/conditionHistory";
import { buildingIdOf, readHpdOnline, searchSteps, violationsPage } from "../engine/hpdOnline";
import { scrapePage, type Scraped } from "./ingest/firecrawl";

// The reading itself (convex/cityPage.ts decides whether one happens). The
// city's data file names the building; Firecrawl opens HPD Online's violations
// page for it in a browser, types the number into the page's own search box,
// opens the row, and hands back the markdown and a picture of the screen. Both
// go into file storage, because Firecrawl's link to the picture expires; the
// markdown is hashed, and its row is read with engine/hpdOnline.ts. Every way
// this can end is written down as it happens.

/** The one ingest/fetch.ts and convex/history.ts send. */
const UA = "Faultline/0.1 (+https://clear-dogfish-72.convex.site; keeps dated copies of public filings)";
/** Firecrawl's own limit on the whole reading, browser steps included. The steps wait about seven seconds. */
const TIMEOUT_MS = 45_000;
/** A reading refused because every browser on the plan is in use is tried once more, this much later. */
const BUSY_RETRY_MS = 20_000;

/** Firecrawl said no browser is free: HTTP 429, after the component's own short retries. */
function tooBusy(e: unknown): boolean {
  const data = (e as { data?: { status?: unknown } })?.data;
  if (data && typeof data === "object" && data.status === 429) return true;
  return /\(429\)/.test(String((e as Error)?.message ?? e));
}

export const capture = internalAction({
  args: { pageId: v.id("cityPages"), violationId: v.string(), buildingId: v.optional(v.string()), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { pageId, violationId, attempt, ...known }): Promise<null> => {
    const end = (outcome: "busy" | "failed", why: string, extra: { buildingId?: string } = {}) =>
      ctx.runMutation(internal.cityPage.finish, { pageId, outcome, why, ...extra });

    let buildingId = known.buildingId ?? null;
    if (!buildingId) {
      try {
        const res = await fetch(cityQuery({ $select: "buildingid", $where: `violationid='${violationId}'`, $limit: "1" }), {
          headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from the city's housing file`);
        buildingId = buildingIdOf(JSON.parse(await res.text()));
      } catch (e) {
        console.warn(`[cityPage] #${violationId}: the city's data file could not be read: ${String(e)}`);
        await end("failed", "the city's data file could not be read for its building");
        return null;
      }
      if (!buildingId) {
        await end("failed", "the city's data file names no building for it");
        return null;
      }
    }

    let page: Scraped;
    try {
      page = await scrapePage(ctx, violationsPage(buildingId), { steps: { actions: searchSteps(violationId), timeoutMs: TIMEOUT_MS } });
    } catch (e) {
      if (tooBusy(e) && attempt < 2) {
        console.log(`[cityPage] #${violationId}: Firecrawl is busy, trying once more in ${BUSY_RETRY_MS / 1000} s`);
        await ctx.scheduler.runAfter(BUSY_RETRY_MS, internal.cityPageCapture.capture, { pageId, violationId, buildingId, attempt: attempt + 1 });
        return null;
      }
      console.warn(`[cityPage] #${violationId} at building ${buildingId}: not read: ${String(e)}`);
      if (tooBusy(e)) await end("busy", "Firecrawl's browsers were all in use, twice", { buildingId });
      else await end("failed", "Firecrawl could not open the page", { buildingId });
      return null;
    }
    if (page.stepsSaid?.length) console.log(`[cityPage] #${violationId} at building ${buildingId}: ${page.stepsSaid.join(" · ")}`);

    // The markdown and its hash first: a picture that fails to arrive loses
    // the picture, not the page.
    const bytes = new TextEncoder().encode(page.markdown);
    const markdownId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "text/markdown; charset=utf-8" }));
    const sha256 = await sha256Hex(bytes);
    let screenshotId: Id<"_storage"> | undefined;
    if (page.screenshotUrl) {
      try {
        const shot = await fetch(page.screenshotUrl);
        if (!shot.ok) throw new Error(`HTTP ${shot.status}`);
        screenshotId = await ctx.storage.store(await shot.blob());
      } catch (e) {
        console.warn(`[cityPage] #${violationId}: picture not kept: ${String(e)}`);
      }
    }

    const read = readHpdOnline(page.markdown, violationId);
    const kept = { buildingId, sha256, markdownId, ...(screenshotId ? { screenshotId } : {}) };
    if (read.kind === "found") {
      await ctx.runMutation(internal.cityPage.finish, {
        pageId,
        outcome: "kept",
        ...kept,
        statusText: read.statusText,
        ...(read.statusDate ? { statusDate: read.statusDate } : {}),
        ...(read.certDate ? { certDate: read.certDate } : {}),
      });
    } else if (read.kind === "not_found") {
      await ctx.runMutation(internal.cityPage.finish, { pageId, outcome: "not_found", ...kept });
    } else {
      // Kept as it was served, with why its row could not be read from it.
      await ctx.runMutation(internal.cityPage.finish, { pageId, outcome: "failed", ...kept, why: read.why });
    }
    console.log(`[cityPage] #${violationId} at building ${buildingId}: ${read.kind}, ${bytes.length} bytes, ${page.credits} credit${page.credits === 1 ? "" : "s"}`);
    return null;
  },
});
