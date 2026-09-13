# Faultline

**Email a company name or a New York City address. Get back what they filed with the government, dated — including every version the agency overwrote.**

Live: **https://clear-dogfish-72.convex.site** · Inbox: **getnotice@agentmail.to** · Tour for judges: [/judge](https://clear-dogfish-72.convex.site/judge)

Built for the Convex All Gas Hackathon (25 Aug – 22 Sep 2026). The build log judges read is [hackathon.md](hackathon.md), one entry per commit.

## The problem, in the government's own words

States publish layoff notices (WARN) and cities publish housing and food-safety records, then overwrite the file in place. Yesterday's version is gone from the source. Some of them say so themselves:

- New York City's restaurant inspection file holds "violation citation[s] … conducted up to three years prior to the most recent inspection for restaurants … in an active status on the RECORD DATE … only restaurants in an active status are included in the dataset." A restaurant closes; its history leaves the file.
- California republishes one spreadsheet at one URL. When a notice is edited, the earlier version is gone.
- New Jersey publishes the *month* it posted a layoff notice, never the date the employer gave — so the one number a worker needs cannot be computed from the state's file at all.
- Wisconsin numbers every notice and lists each revision in an update table of its own, in four codes: AW, LS, OC, RN. It also puts `?version=N` on every PDF link, and on 13 September republished its page with 42 of those numbers changed, 26 of them downward, and nothing else on the page changed. We had read that number as the state's revision count. It is not, and we no longer quote it.

Faultline reads ten of these files on a schedule, diffs every row against the last version it holds, and keeps all of them. Then it answers email.

## What a receipt says

Send **"Spirit Airlines"** to the inbox and the reply, in the same thread, reads the record and never a verdict:

- every filing, in every state, with the notice date and the layoff date side by side and the days between them against the statute that actually applies — New York's WARN Act, Cal-WARN, or federal WARN where a state has none, never a law that doesn't exist;
- whether the state posted the notice after the layoff had already started (that lag is the state's, not the employer's);
- the amendment chain: when a state edits a notice in place, which field moved, from what to what, and the day it was caught;
- the reason the state recorded, and whether those words name an exception the rule allows;
- for a building: the city's own FALSE CERTIFICATION stamp on a landlord's "it's fixed", kept after the city overwrote it, and the restaurants the Health Department closed at that address;
- what is held: rows, versions, how many times the file has been read, and the exact URL and time of the last read.

"Nothing filed" is an answer too, dated to the minute with each file's last read — and followable. Reply **FOLLOW** to hear when anything changes, at most once a day; **STOP** ends it and is honoured before every other rule. **PACK** returns a PDF evidence pack with every version and its hash. **CSV** returns every filing as a spreadsheet for a lawyer, with no limitations column on purpose.

Things it deliberately does not do: say "violation" (the word is *gap*; exceptions are a lawyer's question); print a notice period where the state's file cannot support one; count a 13-worker filing against a statute that doesn't reach it; email an address that has never written to it.

## How it is built

**Convex is the whole backend.** A one-minute cron ticks the sources; each due one runs as a scheduled action that fetches the file, diffs it in a pure TypeScript engine, and commits in slices of 150 rows — a city file is bigger than one transaction — writing the observation, the current-row pointer and the change event together, so a half-finished cycle loses nothing. Full-text search over subjects answers lookups; realtime queries drive every page; file storage holds the evidence packs; HTTP actions serve the AgentMail webhook, share pages with the receipt in the `<head>`, the CSV route and the pack downloads; Convex Auth (email and password only) lets a signed-in person follow from the web. Provider circuit breakers, a kill switch and a per-source daily read cap keep it inside a free plan through judging.

**AgentMail** is the front door and the back door: the inbox receives through the component's Svix-verified webhook, and every receipt, alert, pack and CSV goes back in-thread through the API.

**OpenAI** (gpt-5.6-luna, official SDK) reads letters people forward — PDF attachments included — into a strict zod schema behind a byte-stable cached prefix, and runs one capped hosted web search per filing to put the employer's own public words beside what they filed. Free moderation gates what reaches a reply.

**Firecrawl** fetches Wisconsin's WARN page from its side, because the host does not resolve from the deployment at all; the HTML is parsed like any other state's table.

The sources: WARN files for New York, California, New Jersey, Virginia, Maryland, Colorado, North Carolina and Wisconsin; NYC HPD housing-code violations; NYC DOHMH restaurant inspections. Each is one adapter in `engine/adapters/` that declares how to fetch, what a row's identity is, which fields are significant, and how to say a change in the record's own words.

## Layout

```
engine/      pure TypeScript, zero Convex imports: adapters, canonical hashing, the diff,
             matching, rules (statutes), receipts, the CSV export
convex/      schema, crons, ingest (tick -> fetch -> commit), lookup, inbound mail,
             digest, packs, breakers, HTTP routes
src/         the site: landing, receipts wall, employer and building pages, tour, sign-in
scripts/     fixture tests on real government bytes, plus a copy lint over every
             user-facing string
data/        the fixtures those tests run on
```

## Running it

```
npm install
cp .env.example .env         # keys go on the deployment, not in the file
npx convex dev               # backend
npm run dev                  # site
npm run typecheck && npx tsx scripts/engine-test.ts && npx tsx scripts/receipt-test.ts && npx tsx scripts/copy-lint.ts
```

Deployment env: `OPENAI_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`, `AGENTMAIL_INBOX_ID`, `FIRECRAWL_API_KEY`, `SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`. New sources start in shadow mode — observed and diffed, not emitted — and are promoted after a quiet cycle with `sources:setEmit`.

## Honesty notes

Every claim a receipt makes is checkable against the government URL it names, and the log records the times it was wrong: the day the receipt invented "Virginia's WARN Act", the day "closed 13 restaurants" was thirteen citations of one closure, the day a backwards date range in Maryland's file read as compliance. Those entries are in [hackathon.md](hackathon.md) with the commits that fixed them.
