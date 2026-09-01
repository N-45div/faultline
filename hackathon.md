# Hackathon log

- **Project:** Notice
- **Event:** Convex All Gas Hackathon
- **What it does:** Email a company name or a building address and get back what they filed with the government, dated — with every version kept, because the states overwrite the files. Six state layoff files and New York City housing records.
- **Live app:** https://spotted-elephant-420.convex.site
- **Repo:** https://github.com/N-45div/faultline
- **Frontend:** Convex static hosting
- **Convex deployment:** https://spotted-elephant-420.convex.cloud
- **Components:** @convex-dev/static-hosting, @agentmail/convex, @firecrawl/firecrawl-convex
- **Convex features:** schema, tables, indexes, full-text search, queries, mutations, actions, HTTP actions, crons, scheduled functions, file storage, realtime queries
- **Auth:** none
- **AI models:** gpt-5.6-luna (strict structured outputs, prompt caching, PDF file input, hosted web search), omni-moderation-latest
- **Started:** 2026-08-29T18:42:23Z
- **Last updated:** 2026-09-01T10:15:00Z

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

### 2026-08-31 - 051aea5
The evidence pack is real. Email "PACK Spirit Airlines" and a PDF arrives in
your thread within a minute: cover, the record as it stands with the
notice-gap line in red, every dated version with its capture time and hash,
the changes we recorded, the statute with its exceptions, and how the capture
works — built with pdf-lib in a node action, stored in Convex file storage,
served at `/pack/<token>` ahead of the static catch-all, and attached to the
reply. The model moved to the official OpenAI SDK: one zod schema drives both
the strict output format and runtime validation, and the instructions are a
byte-stable ~1,500-token prefix (per-state WARN table, OWBPA rules) with a
prompt cache key — measured 1,469 of 1,584 input tokens served from cache on
the second letter. An attached PDF letter now goes to gpt-5.6-luna as direct
file input (AgentMail's attachment endpoint returns a signed download_url;
the bytes live behind it), verified on production: a scanned-style letter
extracted with the OWBPA disclosure and ADEA mention caught, at 0.036 cents.
Free moderation screens inbound text before any paid call. Inbox hygiene
shipped and immediately proved itself: robot senders and auto-submitted mail
are stored and never answered — the gate caught our own test mail because
AgentMail stamps List-Unsubscribe on ordinary API sends, so that header alone
no longer counts as a robot; a global daily reply cap protects the inbox's
reputation; outbound mail carries RFC 3834 Auto-Submitted headers; every
reply ends with a STOP line. Deliverability test sent to Gmail. Convex
features: file storage, HTTP actions with pathPrefix routing, node actions,
scheduled functions, indexes (`convex/packs.ts`, `convex/packBuild.ts`,
`convex/llmActions.ts`, `convex/mail.ts`, `engine/hygiene.ts`).

### 2026-08-31 - fdebbea
The city was too big for one transaction. NYC HPD returns about 1,800 rows a
cycle and every cycle died: the read that fetches the previous version asked
for one row per key inside a single Convex query, and the write spent four
database operations per row inside a single mutation. Both hit "too many
system operations", and the source sat in backoff having ingested nothing. A
cycle is now a snapshot, then slices of 150 rows, then a finish; the "before"
side is read in slices of 250 deduped keys; subject lookups are deduped per
batch; the wall is trimmed once per batch instead of once per change. Each
slice carries a row's new version, its `current` pointer and its change event
together, so a slice that never runs loses nothing — the next cycle finds the
row still different and writes both. HPD now ingests 1,800 rows in one cycle
and is out of shadow mode.

Alerts stopped being sent from ingest, because a city file that moves two
hundred rows must never become two hundred emails. A change queues one line
per follower; a cron decides when it leaves. At most one email per person per
day, and the first arrives within a minute of the change. Proven end to end on
a real building: a violation at 107 East 126 Street moved from NOV CERTIFIED
LATE to VIOLATION CLOSED, the alert queued, the threaded reply 404'd on a dead
thread, the failed send was requeued and the thread forgotten, and the next
pass delivered a fresh email — the failure path working on its first outing.

New: what they said in public. One search per employer and filing date, capped
at three, returns the employer's own dated words beside the reason they gave
the state, with citations rendered as links on the employer page. Spirit
Airlines' own release naming it the best airline of 2026 sits three weeks
before a wind-down the state's file calls "Bankruptcy Economic". The search
call and the strict-schema read are deliberately two calls: citation offsets
index into the emitted text, and forcing a JSON schema onto the search would
point them into raw JSON. 3.8 cents, bought once and kept.

STOP now happens before every gate. It had been dropped for exactly the people
most likely to send it — senders who fail SPF, and anyone who had already
written twenty times that day.

An adversarial review of yesterday's code found seven more, all fixed: every
California evidence pack silently dropped the state's posting-lag line,
because California calls that field `processedDate` and New York calls it
`postedDate`; a PDF that was not a letter printed "What your letter says:"
over nothing; a "thanks" in a pack thread rebuilt and re-sent the whole pack;
`news@` addresses were being filed as robots, when reporters are a core
audience; a failed pack promised a retry that nothing performed; the STOP
confirmation ended by inviting the reader to reply FOLLOW; and the subject
line — often the only place a "see attached" email names the employer — never
reached the model. Convex features: node actions, scheduled functions, crons,
indexes, file storage, HTTP actions (`convex/ingest/`, `convex/digest.ts`,
`convex/corroborate.ts`, `engine/hygiene.ts`).

### 2026-09-01 - e43ec43
Four more states, and the hardest part was getting hold of the files at all.
Virginia mints its CSV afresh on every render of its page, names it for the
server's epoch second, and deletes the old one within hours — a URL from
yesterday is a 404. North Carolina renames its file on every publish and
answers the old path with 403. Both are handled by one new idea in the
transport: a discovery step that reads the state's own page and takes today's
link from it, falling back to the last URL we knew if the page is ever
redesigned. It is proven live — two runs minutes apart discovered two
different filenames — and North Carolina's link carries the government's own
S3 version id.

Virginia is the deepest file any of these states publishes: 1,123 notices back
to 2010, where the others publish one year at a time. 479 of them gave less
than the 60 days federal WARN sets. Maryland is an HTML table with no ETag and
no publication date, dates that are sometimes ranges and sometimes typos, and
worker counts written as prose ("2 (Remote workers in MD)"); it needed a small
table reader that picks its table by the header row rather than by position,
because the page carries a second, currently empty, federal log. Colorado is a
Google Sheet the state hand-types and edits in place, and the only file of the
six that says why, in the employer's own words.

Virginia's file names a contact person at each employer. That column is read
and dropped: one named private individual per row, no part of what a laid-off
worker needs, and a record we do not keep cannot leak. The union local is
kept — that someone was represented is exactly what a laid-off person needs —
without the officer's name and postal address printed beside it.

Getting the semantics wrong cost a cycle and was worth the lesson. In this
engine "open_world" means a whole file whose absences are provable and
"closed_world" means a filtered slice that cannot prove them; all four new
states went in the wrong way round. A notice the state deleted could never
have been detected as deleted, and the read that fetches previous versions
fell back to one indexed lookup per row — which killed Virginia's 1,123-row
first cycle with the same "too many system operations" that had killed the
city the day before. Whole-file sources now read their previous versions in a
single index scan, and each state carries a row floor so a short read cannot
read as a mass deletion.

The proof that matters: one query for Crothall Healthcare now returns four
filings across two states, from 2018 to 2026, in one receipt. Convex features:
node actions, crons, scheduled functions, indexes, full-text search
(`engine/adapters/`, `engine/html.ts`, `convex/ingest/fetch.ts`).

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
| 31 Aug (also) | Pulled forward from 1 Sep: batched ingest so a city fits; HPD out of shadow; alert proven with before/after; one digest per person per day; corroboration by web search with citations |
| 1 Sep | Four zero-credit states: Virginia (CSV), Maryland (static HTML), North Carolina (S3 CSV with a government VersionId), Colorado (Google Sheet with stated reasons). Building page and address lookup on the web |
| 2 Sep | Postal address in the footer and AgentMail Developer plan + custom domain (needs Divij); Outlook deliverability; the wall as a demo surface with HPD live |
| 3 Sep | Sign-in: Google and email + password, optional everywhere — saved receipts, FOLLOW from the web, the Monitor team; a judge path that lands on a guided tour with no wall in front of the demo |
| 4 Sep | Paywall on Dodo Payments: $79 pack as a one-time checkout, Monitor $199/$499 as subscriptions; webhook marks the order paid, delivers the pack to the thread, activates the organisation; the PACK reply carries a real payment link |
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
