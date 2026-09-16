# Faultline

**Your landlord told the city the repair is done. Is it? Faultline asks the person living with it, keeps their answer dated beside the city's own record, and tells them the day that record agrees.**

Email **ASK** and a New York City address to **getnotice@agentmail.to**, then answer in your own words. Layoff notices work from the same inbox: email a company name and get back what it filed with the state, including every version the state has since overwritten.

Live: **https://clear-dogfish-72.convex.site** · Inbox: **getnotice@agentmail.to** · Tour for judges: [/judge](https://clear-dogfish-72.convex.site/judge)

Built for the Convex All Gas Hackathon (25 Aug – 22 Sep 2026). The build log judges read is [hackathon.md](hackathon.md), one entry per commit.

## They marked it fixed. Is it?

When an owner certifies to New York City's housing agency, HPD, that a violation has been corrected, the violation closes after 70 days unless HPD reinspects. A tenant may challenge the certification, which triggers that inspection, but the city's file holds only the owner's word: it has no place for the tenant's. In the thirty days from 16 August 2026, the city's own file shows 7,313 violations whose latest status is an owner's certification, and 1,527 whose latest status is HPD's stamp that a certification was FALSE or INVALID. Those are different violations, not a rate; both counts are [one query on the city's file](https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$select=currentstatus%2Ccount(1)&$where=currentstatusdate%3E%3D'2026-08-16'%20AND%20currentstatus%20in('NOV%20CERTIFIED%20ON%20TIME'%2C'NOV%20CERTIFIED%20LATE'%2C'FALSE%20CERTIFICATION'%2C'INVALID%20CERTIFICATION')&$group=currentstatus), refreshed daily on the landing page.

1. **ASK.** Email `ASK 155 Linden Boulevard, Brooklyn`. Within seconds the reply lists each repair the owner certified there that is still inside its 70 days, in the city's words, with the day the 70 days run out. The landing page shows that reply as it reads right now, built by the same functions.
2. **Answer in your own words.** `#19105974 STILL BROKEN` is read with no model at all. "The tiles by the compactor are still cracked" goes to GPT-6 Astra on the OpenAI Agents SDK, which must finish by calling one of ten tools. It records the answer against a violation this person was asked about, or asks which one they meant. The model writes no sentence anyone reads; the tools do, in the service's own words, and the tool that records an answer refuses a violation number the person was never asked about.
3. **Kept, private, dated.** The answer lives on the person's own page, opened by a private link: what the city's file said when we asked, what it says now, HPD's 70 days, and what they said, each dated, with their photo if they sent one. The same page shows what became of every reply we sent them — delivered, bounced, or sent by text — from AgentMail's own delivery events.
4. **The city's second word.** When HPD later stamps that certification FALSE or INVALID, the person who answered is told, with both dates. Only then does the public building page show that someone said so first, and never in their words.

HPD can take the full 70 days to reinspect, so the whole loop (ask, answer, the city's second word, the email that follows) also runs end to end in convex-test.

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

"Nothing filed" is an answer too, dated to the minute with each file's last read — and followable. Reply **FOLLOW** to hear when anything changes, at most once a day; **STOP** ends it and is honoured before every other rule. **PACK** returns a PDF evidence pack with every version and its hash. **CSV** returns every filing as a spreadsheet for a lawyer, with no limitations column on purpose. **KEEP** and a link reads that page through Firecrawl and holds it as it was served, with a picture of it and a checksum, so what it said today can be checked tomorrow.

Things it deliberately does not do: say "violation" about a layoff (the word is *gap*; exceptions are a lawyer's question); print a notice period where the state's file cannot support one; count a 13-worker filing against a statute that doesn't reach it; email an address that has never written to it; show a tenant's words on a public page.

## How it is built

**Convex is the whole backend.** A one-minute cron ticks the sources; each due one runs as a scheduled action that fetches the file, diffs it in a pure TypeScript engine, and commits in slices of 150 rows — a city file is bigger than one transaction — writing the observation, the current-row pointer and the change event together, so a half-finished cycle loses nothing. The tenant loop has tables of its own: every ask and every answer is a dated row, never merged into the city's, and each person's private page opens from a random token. Full-text search over subjects answers lookups; realtime queries drive every page; file storage holds the evidence packs, the bytes of each changed file as served, and Firecrawl's screenshots; HTTP actions serve the AgentMail and Photon endpoints, share pages with the receipt in the `<head>`, the CSV route and the downloads; Convex Auth (email and password only) lets a signed-in person follow from the web. Provider circuit breakers, a kill switch, and daily caps on reads and model runs keep it inside a free plan through judging.

**AgentMail** is the front door and the back door. The AgentMail component receives the inbox's webhook, verifies it, stores each event once, and hands inbound mail to the app; every receipt, alert, pack and CSV goes back in-thread through AgentMail's API from an action. The component also passes on AgentMail's delivery events for those sends (sent, delivered, bounced, complained, rejected), and each marks its reply's receipt, so a person's own page says whether our reply reached them. The component's own send queue is not used: a component runs with its own environment and cannot read the app's API key. A failed send from 30 August already showed it, and production showed it again on 15 September (hackathon.md).

**OpenAI.** GPT-6 Astra on the OpenAI Agents SDK is the inbox agent. A reply that is not a keyword goes to it, and it must finish by calling one of ten strict tools: open questions, find a building, record an answer, ask about a building, look up a record, keep a page someone sent, send the evidence pack, send the filings spreadsheet, read a letter, ask which. The tools write every reply, and three of them are the components: Firecrawl reads a link someone sends, and the pack and the spreadsheet go back through AgentMail as attachments. gpt-5.6-luna reads letters people forward (PDF attachments included) and photographs of HPD notices into a strict zod schema behind a byte-stable cached prefix, and runs one capped hosted web search per filing to put the employer's own public words beside what they filed. Free moderation comes first. Every call is priced into a ledger in cents.

**Firecrawl** fetches Wisconsin's WARN page from its side, because the host does not resolve from the deployment, and waits for the page's own scripts to build its tables. Each read also asks for Firecrawl's change tracking against its previous capture, in git-diff mode, and a full-page screenshot. The same component keeps a page anyone sends the inbox: the agent's keep_a_page tool has Firecrawl read it, the page as served and a picture of it go into file storage with a SHA-256, and the reply says what is held, under a cap of five pages a person a day. Firecrawl's verdict and the lines it saw move are kept with every read, the screenshot is copied into Convex file storage with any read where our own diff found a change, and the commit page shows Firecrawl's reading beside ours, including when they disagree. On 15 September Firecrawl called the page changed on two reads while our diff found no notice had, and Firecrawl's own diff showed why: the only lines that moved were the `?version=N` numbers on the state's PDF links, which changed between two reads half an hour apart. That independently confirms the correction below, that the number is not a revision count.

**Photon** puts the same inbox on a phone number. A signed webhook (HMAC-SHA256 over the timestamp and body, a five-minute window, a constant-time compare) hands each text to the same inbound handler, and replies go back through the Spectrum SDK from a node action as a compact text. Photon's free tier texts only numbers registered to the project, so email is how anyone else can try it.

The sources: WARN files for New York, California, New Jersey, Virginia, Maryland, Colorado, North Carolina and Wisconsin; NYC HPD housing-code violations; NYC DOHMH restaurant inspections. Each is one adapter in `engine/adapters/` that declares how to fetch, what a row's identity is, which fields are significant, and how to say a change in the record's own words.

## Layout

```
engine/      pure TypeScript, zero Convex imports: adapters, canonical hashing, the diff,
             matching, rules (statutes), HPD's vocabulary and the tenant loop's words,
             receipts, the CSV export
convex/      schema, crons, ingest (tick -> fetch -> commit), lookup, inbound mail and texts,
             the inbox agent, attestations, digest, packs, breakers, HTTP routes
src/         the site: landing, receipts wall, employer and building pages, the private
             record page, tour, sign-in
tests/       convex-test: the tenant loop, the inbox agent's tools, the Photon endpoint
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
npx vitest run               # the Convex functions, in memory
```

Deployment env: `OPENAI_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`, `AGENTMAIL_INBOX_ID`, `FIRECRAWL_API_KEY`, `SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`. Optional: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` and `SPECTRUM_WEBHOOK_SECRET` for Photon; `OPENAI_AGENT_MODEL` to run the inbox agent on something other than `gpt-6-astra`. New sources start in shadow mode — observed and diffed, not emitted — and are promoted after a quiet cycle with `sources:setEmit`.

## Honesty notes

Every claim a receipt makes is checkable against the government URL it names, and the log records the times it was wrong: the day the receipt invented "Virginia's WARN Act", the day "closed 13 restaurants" was thirteen citations of one closure, the day a backwards date range in Maryland's file read as compliance, the day Wisconsin's `?version=N` link parameter was read as a revision count, and the day replies moved onto the AgentMail component's send queue failed in production and were moved back within minutes. Those entries are in [hackathon.md](hackathon.md) with the commits that fixed them.
