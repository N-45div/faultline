import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in memory; the edge runtime is the closest
// match to the Convex runtime for queries and mutations.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["tests/**/*.test.ts"],
    server: { deps: { inline: ["convex-test", "@agentmail/convex", "@convex-dev/workpool"] } },
  },
});
