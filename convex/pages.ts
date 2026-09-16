"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { sha256Hex } from "../engine/canon";
import { scrapePage } from "./ingest/firecrawl";

// A page someone sends us, kept. Firecrawl reads it from its side and hands
// back the page as it was served and a picture of it; both go into file
// storage with a checksum, so what anyone quotes from it later can be checked
// against the copy we hold, whatever the publisher does to the page after.
//
// The model only chooses the address. Everything the person reads is written
// by the mutation this ends in.

export const keep = internalAction({
  args: { inboxId: v.id("inbox"), url: v.string() },
  returns: v.string(),
  handler: async (ctx, { inboxId, url }): Promise<string> => {
    const clean = url.trim().slice(0, 500);
    if (!clean.startsWith("https://") && !clean.startsWith("http://")) {
      await ctx.runMutation(internal.inbound.agentPageRefused, { inboxId, url: clean, why: "that is not a web address" });
      return "not a web address";
    }
    const room: { ok: boolean; why: string } | null = await ctx.runQuery(internal.inbound.agentPageRoom, { inboxId });
    if (!room) return "no such message";
    if (!room.ok) {
      await ctx.runMutation(internal.inbound.agentPageRefused, { inboxId, url: clean, why: room.why });
      return room.why;
    }

    try {
      // Firecrawl waits for the page's own scripts, and returns its change
      // tracking against its previous capture for us, so a page we have read
      // before says whether it moved.
      const page = await scrapePage(ctx, clean, { waitForMs: 3_000, evidence: true });
      const bytes = new TextEncoder().encode(page.html);
      const bodyStorageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "text/html" }));
      let screenshotStorageId: string | undefined;
      if (page.screenshotUrl) {
        try {
          const shot = await fetch(page.screenshotUrl);
          if (shot.ok) screenshotStorageId = await ctx.storage.store(await shot.blob());
        } catch (e) {
          console.warn(`[page] picture not kept: ${String(e)}`);
        }
      }
      const heading = page.markdown.split("\n").find((l) => l.startsWith("# "));
      await ctx.runMutation(internal.inbound.agentPageKept, {
        inboxId,
        url: clean,
        finalUrl: page.url,
        sha256: await sha256Hex(bytes),
        bytes: bytes.length,
        title: heading ? heading.slice(2).trim().slice(0, 120) : "",
        bodyStorageId: bodyStorageId as any,
        ...(screenshotStorageId ? { screenshotStorageId: screenshotStorageId as any } : {}),
        ...(page.changeStatus ? { changeStatus: page.changeStatus } : {}),
      });
      console.log(`[page] kept ${clean} (${bytes.length} bytes, ${page.credits} credit${page.credits === 1 ? "" : "s"})`);
      return "kept and replied";
    } catch (e) {
      console.warn(`[page] ${clean} could not be read: ${String(e)}`);
      await ctx.runMutation(internal.inbound.agentPageRefused, { inboxId, url: clean, why: "the page could not be read" });
      return "could not be read";
    }
  },
});
