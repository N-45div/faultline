# Notice

Email us a company name or a building address. We send back what they told the
government — and keep every version, because they overwrite the old ones.

Built for the Convex All Gas Hackathon (Aug 25 – Sep 22, 2026).
The build log judges read is [hackathon.md](hackathon.md).

- `engine/` — pure TypeScript: adapters for each government file, canonical
  hashing, the diff engine, matching, receipts. Zero Convex imports; tested on
  real bytes with `npx tsx scripts/engine-test.ts` and `scripts/receipt-test.ts`.
- `convex/` — the backend: cron → scheduler → fetch → diff → commit, full-text
  lookup, the inbox handler, the public wall.
- `src/` — the landing page and receipt pages (Vite + React, hosted on Convex).
