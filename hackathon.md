# Notice — build log

**Convex All Gas Hackathon** · started 29 Aug 2026 · submission 22 Sep 2026, 12:00 PM PT

> Email us a company name or a building address. We send back what they told the government —
> and keep every version, because they overwrite the old ones.

## What it is

When a company lays people off, or a landlord says a repair is done, they tell you one story. They
also file paperwork with the government, and that paperwork often tells a different one. Almost
nobody knows the filings exist, and the files get overwritten — yesterday's version is gone.

Notice reads three government files on a schedule, keeps every dated version, and turns any question
into a receipt:

- **Layoffs.** New York and California publish every WARN layoff notice: employer, site, headcount,
  notice date, layoff date. Of 193 notices in New York's file on 29 Aug 2026, **87 gave less than the
  90 days the law requires** and **96 were posted after the layoff had already started**. California
  publishes a single spreadsheet and overwrites it in place — we hold every version since 29 Aug;
  nobody else does, including California.
- **Housing.** NYC HPD stamps a landlord's "it's fixed" as **FALSE CERTIFICATION** — in those words —
  about 38 times a day, then overwrites the status. We keep the stamp.

Email the address with a name. Twenty seconds later, in the same thread: the filing, the gap, the
statute, the state's own page, and the date we captured it. Reply FOLLOW to hear when it changes.
Paste your letter and we set what they told you beside what they filed.

We never say "illegal". We show two dates and one statute, and link to the government's page.
Employers can claim exceptions; that is a lawyer's call. We are the dated proof you bring them.

## Stack

- **Convex** — the only archive of files that overwrite themselves: cron → scheduler → fetch →
  parse → hash → diff → commit, every 15–60 minutes, three governments. Full-text search over
  subjects, live board for a group, static hosting on convex.site.
- **AgentMail** — the address *is* the product. Receives the question, replies in-thread with the
  receipt, emails followers when a filing changes.
- **Firecrawl** — the states with no data feed (HTML-only WARN pages) and employer PDFs.
- **OpenAI** — reads a pasted letter once and pulls out the claim, so it can sit beside the filing.
  Never in the ingest path; every date calculation is deterministic.

## Plan

| Date | Ship |
|---|---|
| 29 Aug | Engine (adapters, canonical hashing, diff with noise rules, shadow mode), three sources ingesting on a cron, wall + hero page, **lookup → receipt → inbound email handler** |
| 30 Aug | AgentMail keys; first real round trip; FOLLOW subscriptions; employer + building pages |
| 31 Aug | OpenAI letter extraction (schema-constrained, cached by body hash); rate limits |
| 1–2 Sep | Cloud deployment, convex.site hosting + smoke test; public repo; HPD out of shadow |
| 3–4 Sep | Change → email followers; group board with member links |
| 5–6 Sep | Housing receipts by address; building page |
| 7 Sep | Buffer; throwaway video take |
| 8–10 Sep | Evidence pack (PDF); cold-visitor landing; copy lint |
| 11–13 Sep | Firecrawl: HTML-only states + employer newsroom captures; share images; teaser post |
| 14–16 Sep | Hardening: judging-week protections, redaction, chaos test with keys removed |
| 17–18 Sep | Video |
| 19–20 Sep | This file, final; posts; submission ready |
| 21 Sep | Freeze |
| 22 Sep | Submit before 12:00 PT |

## Log

### 29 Aug
- Verified the data live: NY WARN Tableau CSV (the `?:showVizHome=no` suffix is load-bearing —
  without it, a WAF captcha), CA EDD xlsx (ETag; conditional GET returns 304), NYC HPD Socrata.
- Engine as pure TypeScript with zero Convex imports, tested on real bytes: same bytes → zero
  changes; one edited field → one change naming that field; a captcha-sized body → degraded, zero
  removals. Identity-keyed rows, two hashes (significant fields vs. everything), noise rules as data.
- Three sources ingesting on the built-in cron; 1,992 rows held; NY and CA promoted out of shadow
  after proving zero noise on identical bytes; HPD stays in shadow 24h.
- Hero page computes the 87/193 statistic live from held rows. Routing proven: exact routes beat
  the static catch-all.
- Started: deterministic lookup (company + address matching, Convex full-text search), receipt
  renderer, inbound email classifier.
