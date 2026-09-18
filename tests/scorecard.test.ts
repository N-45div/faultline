/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../convex/schema";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { api } from "../convex/_generated/api";

// refreshScorecard stores a fingerprint beside the numbers so an unchanged
// file skips the full re-read. The public query must not hand that field back:
// its validator does not know it, and the live /scorecard page failed on it.

const modules = import.meta.glob("../convex/**/*.*s");

test("the scorecard query returns the card without the stored fingerprint", async () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("stats", {
      key: "scorecard",
      value: { asOf: 1, states: [], fingerprint: "ny-warn:abc|ca-warn:?" },
      updatedAt: 1,
    });
  });
  const card = await t.query(api.wall.scorecard, {});
  expect(card).toEqual({ asOf: 1, states: [] });
});
