"use node";

import { v } from "convex/values";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { internalAction } from "./_generated/server";

// Photon: Faultline as a number you text. Sending goes through the Spectrum
// SDK over gRPC, which needs Node, so it lives in a node action. This first
// piece proves the one thing the rest depends on — that a Convex action can
// open the SDK, find an existing thread and send into it.

type Sendable = { send: (body: string) => Promise<unknown> };

export const probeSend = internalAction({
  args: { handle: v.string(), body: v.string() },
  returns: v.object({ ok: v.boolean(), ms: v.number(), detail: v.string() }),
  handler: async (_ctx, { handle, body }) => {
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
  },
});
