# Hackathon log

- **Project:** Notice
- **Event:** Convex All Gas Hackathon
- **What it does:** Email a company name or a building address and get back what they filed with the government, dated — with every version kept, because the states overwrite the files.
- **Live app:** https://spotted-elephant-420.convex.site
- **Repo:** https://github.com/N-45div/faultline
- **Frontend:** Convex static hosting
- **Convex deployment:** https://spotted-elephant-420.convex.cloud
- **Components:** @convex-dev/static-hosting, @agentmail/convex, @firecrawl/firecrawl-convex
- **Convex features:** schema, tables, indexes, full-text search, queries, mutations, actions, HTTP actions, crons, scheduled functions, file storage, realtime queries
- **Auth:** none
- **AI models:** gpt-5.6-luna
- **Started:** 2026-08-29T18:42:23Z
- **Last updated:** 2026-08-30T09:00:00Z

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

### 2026-08-30 - 988db42
Landing page: search box, a three-step explainer, and a mobile layout
(`src/App.tsx`, `src/styles.css`). Deployed to production: functions on
`spotted-elephant-420.convex.cloud`, the site on Convex static hosting at
`spotted-elephant-420.convex.site`, exact routes verified to beat the SPA
catch-all. The three sources bootstrapped on production and the cron took over
within a minute; 1,992 rows held.

### 2026-08-30 - dc901ea
The address is real. An AgentMail inbox receives mail through the component's
webhook on production; replies go back in-thread through AgentMail's API from an
app action, because a component cannot read the deployment's key. A pasted letter
is read once by gpt-5.6-luna with a strict JSON schema (employer, dates, stated
reason quoted verbatim, release deadline, whether the OWBPA age-and-title list was
attached) and the result is cached by the letter's content hash, so the same
letter forwarded again costs nothing; every call is priced in cents in a ledger
(`convex/llm.ts`). FOLLOW creates a subscription, and when a followed filing
changes, the commit that records it schedules an email to each follower in their
own thread (`convex/mail.ts`, `convex/inbound.ts`, `convex/ingest/write.ts`).
Verified on production: a lookup answered in 2 seconds, a letter in 6, at
0.03 cents. Convex features: actions, scheduled functions, mutations, indexes.

## About

When a company lays people off, or a landlord says a repair is done, they tell
you one story. They also file paperwork with the government, and that paperwork
often tells a different one. Almost nobody knows the filings exist, and the
files get overwritten — yesterday's version is gone.

- **Layoffs.** New York and California publish every WARN layoff notice. Of 193
  notices in New York's file on 29 Aug 2026, 87 gave less than the 90 days the
  law requires, and 96 were posted after the layoff had already started.
  California publishes its current-year notices as one spreadsheet and overwrites
  it in place — edits within the year are lost, and only fiscal-year-end PDFs
  survive on the state's site. We hold every version since 29 Aug.
  Two dates matter and we keep them apart: the notice date is the employer's; the
  posting date is the state's. "Posted after the layoff started" is about the
  state's lag, never the employer's.
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
| 31 Aug | Evidence pack v1 (PDF: letter, every archived version with hash + capture time, statute, intervals); inbox hygiene — rate limiter, RFC 3834 auto-reply headers, skip list/bounce/auto-submitted mail, free moderation on inbound, STOP + postal footer; deliverability test to Gmail and Outlook. OpenAI: official SDK with one zod schema driving strict output and validation, a stable ≥1,024-token prefix with a cache key so every letter after the first pays the cached rate; attached PDF letters go to the model directly as file input |
| 1 Sep | HPD out of shadow, wall live; change → follower alert proven with before/after; one digest per follower per day. Corroboration on demand: one web-search call per employer and filing date, restricted to the employer's site and local press, returning a dated statement with citations — the state's stated reason beside the employer's own words |
| 2 Sep | Four zero-credit states: Virginia (CSV), Maryland (static HTML), North Carolina (S3 CSV with a government VersionId), Colorado (Google Sheet with stated reasons) |
| 3 Sep | Sign-in: Google and email + password, optional everywhere — saved receipts, FOLLOW from the web, the Monitor team; a judge path that lands on a guided tour with no wall in front of the demo |
| 4 Sep | Paywall on Dodo Payments: $79 pack as a one-time checkout, Monitor $199/$499 as subscriptions; webhook marks the order paid, delivers the pack to the thread, activates the organisation; the PACK reply carries a real payment link. Building page and address lookup on the web |
| 5 Sep | Ten receipts to ten plaintiff-side firms and tenant litigators — the thirty-day test; employer share pages; the data post; AgentMail Developer plan + custom domain, warmup starts |
| 6 Sep | Judging-week protections: provider circuit breakers, "last verified" badges, kill switch, chaos test with keys revoked, storage GC, copy lint |
| 7 Sep | New Jersey and Illinois (the overwritten-file states with 90/60-day laws); throwaway video take; log refresh |
| 8–10 Sep | Evidence pack (PDF); cold-visitor landing; copy lint |
| 11–13 Sep | Firecrawl: HTML-only states and employer newsroom captures; share images; teaser post |
| 14–16 Sep | Hardening: judging-week protections, redaction, chaos test with keys removed |
| 17–18 Sep | Video |
| 19–20 Sep | This file, final; posts; submission ready |
| 21 Sep | Freeze |
| 22 Sep | Submit before 12:00 PT |
