# Hackathon log

- **Project:** Notice
- **Event:** Convex All Gas Hackathon
- **What it does:** Email a company name or a building address and get back what they filed with the government, dated — with every version kept, because the states overwrite the files.
- **Live app:** not deployed
- **Repo:** https://github.com/N-45div/faultline
- **Frontend:** Convex static hosting
- **Convex deployment:** not deployed
- **Components:** @convex-dev/static-hosting, @agentmail/convex, @firecrawl/firecrawl-convex
- **Convex features:** schema, tables, indexes, full-text search, queries, mutations, actions, HTTP actions, crons, scheduled functions, file storage, realtime queries
- **Auth:** none
- **AI models:** none
- **Started:** 2026-08-29T18:42:23Z
- **Last updated:** 2026-08-29T18:44:48Z

## Log

### 2026-08-29 - b9ed936
Three government files read on a schedule and kept as dated versions: New York
and California WARN layoff notices, and NYC HPD housing violations. A pure
TypeScript engine (`engine/`) parses each file, hashes rows on their significant
fields, and diffs against the last version so a page that reshuffles its HTML
produces zero false changes; tested on real bytes with `scripts/engine-test.ts`.
A one-minute cron schedules a fetch action per due source, which commits
observations, changes and a pinned copy of the bytes in one mutation; new
sources start in shadow mode. The landing page computes, live from held rows,
that 87 of 193 New York notices gave less than the 90 days the law sets.
Convex features: schema, indexes, crons, scheduled functions, actions,
mutations, queries, file storage, HTTP actions, realtime queries
(`convex/schema.ts`, `convex/crons.ts`, `convex/ingest/`, `convex/wall.ts`,
`convex/http.ts`, `src/App.tsx`).

### 2026-08-29 - f6be936
The address that writes back. An inbound email is classified without a model —
a company name, a New York City address, a pasted letter, FOLLOW or STOP — and
answered in-thread with a receipt: the filing, the notice gap against the
statute, the date the state put it online, the state's own page, and the date
we captured it. Company and address matching use Convex full-text search over
subjects plus deterministic scoring; a pasted letter is matched to the employer
it names; an address we do not hold yet starts a pull from the city on the spot;
FOLLOW creates a subscription. The same receipt renders on the web at
`/e/<company>`. Convex features: full-text search, mutations, scheduled
functions, actions, queries (`convex/lookup.ts`, `convex/inbound.ts`,
`convex/ingest/seed.ts`, `engine/match.ts`, `engine/intent.ts`,
`engine/receipt.ts`, `src/Employer.tsx`).

### 2026-08-30 - working tree
Landing page: search box, a three-step explainer, and a mobile layout
(`src/App.tsx`, `src/styles.css`).

## About

When a company lays people off, or a landlord says a repair is done, they tell
you one story. They also file paperwork with the government, and that paperwork
often tells a different one. Almost nobody knows the filings exist, and the
files get overwritten — yesterday's version is gone.

- **Layoffs.** New York and California publish every WARN layoff notice. Of 193
  notices in New York's file on 29 Aug 2026, 87 gave less than the 90 days the
  law requires, and 96 were posted after the layoff had already started.
  California publishes one spreadsheet and overwrites it in place; we hold every
  version since 29 Aug.
- **Housing.** NYC HPD stamps a landlord's "it's fixed" as FALSE CERTIFICATION —
  in those words — about 38 times a day, then overwrites the status. We keep the
  stamp.

We never say "illegal". We show two dates and one statute and link to the
government's page. Employers can claim exceptions; that is a lawyer's call. We
are the dated proof you bring them.

## Plan

| Date | Ship |
|---|---|
| 29 Aug | Engine, three sources on a cron, wall + hero page, lookup → receipt → inbox |
| 30 Aug | Cloud deployment and convex.site; AgentMail round trip; FOLLOW; employer and building pages |
| 31 Aug | OpenAI letter extraction (schema-constrained, cached by body hash); rate limits |
| 1–2 Sep | Hosting smoke test; HPD out of shadow; public wall |
| 3–4 Sep | Change → email followers; group board with member links |
| 5–6 Sep | Housing receipts by address; building page |
| 7 Sep | Buffer; throwaway video take |
| 8–10 Sep | Evidence pack (PDF); cold-visitor landing; copy lint |
| 11–13 Sep | Firecrawl: HTML-only states and employer newsroom captures; share images; teaser post |
| 14–16 Sep | Hardening: judging-week protections, redaction, chaos test with keys removed |
| 17–18 Sep | Video |
| 19–20 Sep | This file, final; posts; submission ready |
| 21 Sep | Freeze |
| 22 Sep | Submit before 12:00 PT |
