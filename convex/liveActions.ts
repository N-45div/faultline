"use node";

import { v } from "convex/values";
import WebSocket from "ws";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// A conversation with gpt-live-1 is billed by the second, and it is the
// person's browser that holds it open. A page can be left in a tab, or not be
// our page at all. So every conversation is given an end when it is made
// (convex/voice.ts schedules this), and the end is carried out from here:
// OpenAI lets the server that made a session attach to it, and an attached
// server may close it. If the conversation is already over there is nothing to
// attach to, and that is the answer wanted.

const ATTACH = (liveId: string) => `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(liveId)}/attach`;

export const hangUp = internalAction({
  args: { row: v.id("liveSessions") },
  returns: v.null(),
  handler: async (ctx, { row }): Promise<null> => {
    const live: { liveId: string; ended: boolean } | null = await ctx.runQuery(internal.web.liveRow, { row });
    const key = process.env.OPENAI_API_KEY;
    if (!live || live.ended || !key) return null;

    const seconds = await new Promise<number | null>((resolve) => {
      let done = false;
      const finish = (s: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        resolve(s);
      };
      const socket = new WebSocket(ATTACH(live.liveId), { headers: { Authorization: `Bearer ${key}` } });
      const timer = setTimeout(() => finish(null), 15_000);
      socket.on("open", () => socket.send(JSON.stringify({ type: "session.close" })));
      socket.on("message", (data) => {
        const text = String(data);
        // A sideband is also sent the audio both ways. None of it is wanted here.
        if (text.length > 4_000 || !text.includes("session.closed")) return;
        try {
          const event = JSON.parse(text);
          if (event?.type === "session.closed") finish(Number(event?.usage?.seconds ?? 0) || null);
        } catch {
          /* not an event */
        }
      });
      socket.on("error", () => finish(null));
      socket.on("unexpected-response", () => finish(null));
      socket.on("close", () => finish(null));
    });

    await ctx.runMutation(internal.web.liveClosed, { row, ...(seconds !== null ? { seconds } : {}) });
    console.log(`[live] ended ${live.liveId.slice(0, 12)}… from the server${seconds !== null ? ` at ${seconds}s` : " (it was already over, or could not be reached)"}`);
    return null;
  },
});
