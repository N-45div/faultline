"use node";

import { v } from "convex/values";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { internalAction } from "./_generated/server";

// Photon: Faultline as a number you text. Sending goes through the Spectrum
// SDK over gRPC, which needs Node, so it lives in a node action; the SDK and
// its gRPC peers are left unbundled (convex.json) so their runtime imports
// resolve. A connection takes most of the fourteen seconds a send takes.

type Sendable = { send: (body: string) => Promise<unknown> };

async function sendOnce(handle: string, body: string): Promise<{ ok: boolean; ms: number; detail: string }> {
  const started = Date.now();
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) return { ok: false, ms: 0, detail: "no Spectrum credentials on this deployment" };
  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  try {
    const im = imessage(app);
    let space: Sendable | null = null;
    try {
      space = (await im.space.get(`any;-;${handle}`)) as unknown as Sendable;
    } catch {
      space = null;
    }
    if (!space) {
      const user = await im.user(handle);
      space = (await im.space.create(user)) as unknown as Sendable;
    }
    const r = await space.send(body);
    return { ok: true, ms: Date.now() - started, detail: JSON.stringify(r ?? null).slice(0, 200) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, detail: String(e).slice(0, 300) };
  } finally {
    try {
      await (app as unknown as { stop?: () => Promise<void> }).stop?.();
    } catch {
      // already stopped
    }
  }
}

/**
 * One text into the person's conversation. A failure is logged, not retried:
 * texting a phone again every minute is worse than one missed message, and
 * the receipt is already stored.
 */
export const sendText = internalAction({
  args: { handle: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (_ctx, { handle, text }) => {
    const r = await sendOnce(handle, text.slice(0, 3_500));
    const who = `...${handle.slice(-4)}`;
    if (r.ok) console.log(`[photon] sent to ${who} in ${r.ms} ms`);
    else console.error(`[photon] send to ${who} failed after ${r.ms} ms: ${r.detail}`);
    return null;
  },
});

/** Operator's check that sending works from this deployment. */
export const probeSend = internalAction({
  args: { handle: v.string(), body: v.string() },
  returns: v.object({ ok: v.boolean(), ms: v.number(), detail: v.string() }),
  handler: async (_ctx, { handle, body }) => sendOnce(handle, body),
});
