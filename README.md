# Faultline

### Your landlord told the city the repair is done. Is it?

Faultline asks the person living with it, keeps their answer dated beside the city's own record, and tells them the day that record agrees. It also keeps every government file the government overwrites — layoff notices, housing violations, restaurant inspections — so yesterday's version still exists when someone needs it.

It is an inbox. There is nothing to install and no account to make. **No email handy? [Try it in your browser](https://clear-dogfish-72.convex.site/try)**: the same handler, the same agent, the reply arriving live, with no sign-in.

**Live:** https://clear-dogfish-72.convex.site · **Try it, no email:** [/try](https://clear-dogfish-72.convex.site/try) · **Demo:** [video](https://www.youtube.com/watch?v=oZGHuZrlAnQ) · **Inbox:** getnotice@agentmail.to · **Tour for judges:** [/judge](https://clear-dogfish-72.convex.site/judge) · **Build log:** [hackathon.md](hackathon.md), one entry per commit

Built for the Convex All Gas Hackathon, 25 August – 22 September 2026.

---

## Try it in sixty seconds

**In a browser:** open [/try](https://clear-dogfish-72.convex.site/try) and press the first button. What you type goes through the handler an email goes through, the reply arrives on the page by itself from a live Convex query, and under each of your messages it says how it was read: by the keyword reader with no model, or by GPT-6 Astra, with the tool it finished on and what the run cost. Nothing is emailed, and what is said in a trial is never counted on a public page.

**By voice:** on the same page press **Say it**, answer out loud the way you'd tell a neighbour, and press again. OpenAI writes your words down, the recording is dropped, and the words go through the same door as typing. Every reply has a **Listen** button, and what it reads is what the tool wrote, made sayable: no web addresses, a violation by its last four digits, forty seconds at most. The model writes no sentence you hear; it writes down yours and reads out ours.

**As a conversation:** press **Talk to it** and speak. gpt-live-1 is the voice, over WebRTC, listening and speaking at once. It is told it knows nothing about any building or law: when you ask for something it hands your words to the same door as typing, so the keyword reader, GPT-6 Astra and the tools decide and write the reply, and that reply is handed back for the voice to say. A conversation is the one place a model may rephrase what is heard, so the page says what is true: the written reply in the thread is the record, the voice is not. Every conversation is ended by the server at two and a half minutes, whatever the page does.

**By phone:** once it has asked you about a repair, the same page offers to ring you (US and Indian numbers). CALL-E places a real call on our line, says at once that it is automated and that you asked for it, and puts the same questions to you by voice. When you hang up, the transcript appears in your thread and is read twice, separately: by CALL-E, which held the conversation, and by GPT-6 Astra, which is not shown what CALL-E made of it. An answer is recorded only where the two agree; a quote is kept only if the transcript has you saying it; where they differ, nothing is recorded and you are asked again in writing. A number must be written by the person asking, is rung at most twice a day, and is never rung again if whoever answers says they did not ask. Our tables keep a hash of it and its last four digits.

**By email:** write to **getnotice@agentmail.to**. Any of these, in the subject or the first line:

| Write this | What comes back, in the same thread |
|---|---|
| `ASK 155 Linden Boulevard, Brooklyn` | Every repair the owner has certified to the city at that address that is still inside its 70 days, in the city's own words, with the day the clock runs out |
| *(then answer it)* `#19114297 STILL BROKEN`, or just "the tiles by the compactor are still cracked" | Your answer, kept and dated beside the city's record, on a private page only you have the link to |
| `Spirit Airlines` | Every layoff notice it filed, in every state we read, with the days between notice and layoff against the statute that actually applies |
| `FOLLOW` | One email a day at most, when anything you follow changes. `STOP` ends it, and is honoured before every other rule |
| `PACK` | A PDF evidence pack: every version we hold, each with its hash and capture time |
| `CSV` | Every filing as a spreadsheet for a lawyer. No limitations column, on purpose |
| `KEEP https://…` | That page read through Firecrawl and held as it was served, with a picture of it and a SHA-256 |
| `FIND Linden Plaza Preservation LLC` | Every page on the open web that names them, and the first one held the same way |
| `CALL ME +1 718 555 0142` | Your phone rings and the same questions are put to you by voice. The call is read twice, and only what both readers agree on is recorded |

A reply that is not one of those words goes to the inbox agent, which must finish by calling one of twelve tools. It never writes a sentence you read.

---

## Why it exists

When an owner certifies to New York City's housing agency, HPD, that a violation has been corrected, the violation closes after 70 days unless HPD reinspects. A tenant may challenge the certification, which triggers that inspection — but the city's file holds only the owner's word. **It has no column for the tenant's.**

In the thirty days from 16 August 2026, the city's own file shows **7,313** violations whose latest status is an owner's certification, and **1,527** whose latest status is HPD's stamp that a certification was FALSE or INVALID. Those are different violations, not a rate; both counts come from [one query on the city's file](https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$select=currentstatus%2Ccount(1)&$where=currentstatusdate%3E%3D'2026-08-16'%20AND%20currentstatus%20in('NOV%20CERTIFIED%20ON%20TIME'%2C'NOV%20CERTIFIED%20LATE'%2C'FALSE%20CERTIFICATION'%2C'INVALID%20CERTIFICATION')&$group=currentstatus), refreshed daily on the landing page.

The loop, end to end:

1. **Ask.** The reply lists each certified repair still inside its 70 days. The landing page shows that same reply as it reads right now, built by the same functions.
2. **They answer in their own words.** `#19105974 STILL BROKEN` is read with no model at all. A sentence goes to GPT-6 Astra, which picks the tool — and which repair the words are about is settled by embeddings in a Convex vector index, not by the model's guess.
3. **Kept, private, dated.** The answer lives on their own page behind a random token: what the city's file said when we asked, what it says now, HPD's 70 days, their words, their photo if they sent one — and whether our reply reached them, delivered, bounced, or sent by text.
4. **The city's second word.** When HPD later stamps that certification FALSE or INVALID, the person who answered is told, with both dates. Only then does the public building page show that someone said so first, and never in their words.

HPD can take the full 70 days to reinspect, so the whole loop also runs end to end in convex-test, in memory, in under a second.

## The same problem, in the government's own words

States publish layoff notices (WARN) and cities publish housing and food-safety records, then overwrite the file in place. Yesterday's version is gone from the source. Some of them say so themselves:

- **New York City's restaurant file** holds citations "in an active status on the RECORD DATE … only restaurants in an active status are included in the dataset." A restaurant closes; its history leaves the file.
- **California** republishes one spreadsheet at one URL. When a notice is edited, the earlier version is gone.
- **New Jersey** publishes the *month* it posted a notice, never the date the employer gave — so the one number a worker needs cannot be computed from the state's file at all.
- **Wisconsin** numbers every notice and lists each revision in an update table of its own. It also puts `?version=N` on every PDF link, and on 13 September republished its page with 42 of those numbers changed, 26 of them downward, and nothing else changed. We had read that number as the state's revision count. It is not, and we no longer quote it.

Faultline reads **ten** of these files on a schedule, diffs every row against the last version it holds in a pure TypeScript engine, and keeps all of them.

## What a receipt says

Send a company name and the reply reads the record, never a verdict:

- every filing, in every state, with the notice date and the layoff date side by side, and the days between them against the statute that actually applies — New York's WARN Act, Cal-WARN, or federal WARN where a state has none, never a law that doesn't exist;
- whether the state posted the notice after the layoff had already started (that lag is the state's, not the employer's);
- the amendment chain: when a state edits a notice in place, which field moved, from what to what, and the day it was caught;
- the reason the state recorded, and whether those words name an exception the rule allows;
- the 30- and 90-day picture: "3rd notice from X at this address in 74 days, 61 workers cumulative", the batching pattern workers describe and no tracker computes;
- for a building: the city's own FALSE CERTIFICATION stamp on a landlord's "it's fixed", kept after the city overwrote it, and the restaurants the Health Department closed at that address;
- what is held: rows, versions, how many times the file has been read, and the exact URL and time of the last read.

## What a receipt will not do

Say "violation" about a layoff (the word is *gap*; exceptions are a lawyer's question). Print a notice period where the state's file cannot support one. Count a 13-worker filing against a statute that doesn't reach it. Email an address that has never written to it. Show a tenant's words on a public page.

"Nothing filed" is an answer too — dated to the minute, with each file's last read, and followable.

---

## Sponsor depth

| | Where it does real work |
|---|---|
| **Convex** | The whole backend. 33 tables, 60 indexes, a full-text index and a vector index; 176 deployed functions (55 queries, 81 mutations, 27 actions, 13 HTTP); 8 crons; file storage for packs, held bytes and screenshots; realtime queries behind every page; Convex Auth; static hosting; convex-test. **Four components:** static hosting, AgentMail, Firecrawl, and `@convex-dev/rate-limiter`, which holds one counter for each ceiling the inbox keeps instead of counting a table that only grows, and gives the browser trial rooms of its own, so a public page that can reach a paid model cannot spend the inbox's replies or its agent runs. |
| **AgentMail** | The front door and the back door. The component verifies the inbox's webhook, stores each event once, and hands us inbound mail and the delivery events for what we send. Those events are **acted on**: a bounce, rejection or complaint writes the address down and takes every follow off with it — a complaint is final, a bounce clears when mail arrives from that address, which is proof the mailbox works. Every inbound message is **labelled where it lives**: how it was read, what it was about, what came of it, with `unread` removed when the reply goes, so what is still unread in the inbox is exactly what nothing has handled. Attachments both ways: PDFs and photos in, packs and spreadsheets out. |
| **OpenAI** | GPT-6 Astra on the Agents SDK is the inbox agent: **twelve strict tools**, tool choice required, one call at a time, at most six turns, a byte-stable cached prefix, a cost ledger in cents and a daily cap. gpt-5.6-luna reads forwarded letters and photographed notices into one zod schema that drives both strict output and validation, with PDF and image input and a capped hosted web search. **text-embedding-3-small** embeds the condition behind every question we ask and the sentence a person answers with. **gpt-4o-mini-transcribe** and **gpt-4o-mini-tts** let someone say their answer and hear ours, with the recording never kept and only our own tool-written replies ever read aloud. **gpt-live-1** holds a full conversation in the browser with **client delegation**: the voice asks the page for help, the page asks the inbox, and the tool-written reply goes back as `session.commentary.append`; the server attaches to every session from a node action and closes it at the time limit. GPT-6 Astra is also the **second reader of every phone call**. Free moderation runs first. |
| **Firecrawl** | Fetches Wisconsin's page from its side, because the host does not resolve from the deployment, and waits for the page's own scripts. Every read asks for **change tracking in git-diff mode** and a **full-page screenshot**, so each capture carries a second reading beside ours — including when the two disagree. **KEEP** holds any page someone sends, as served, hashed. **FIND** uses Firecrawl **search** for the other half of the question: what does this owner say where we have not looked? |
| **Photon** | The same inbox on a phone number: a signed webhook (HMAC-SHA256, five-minute window, constant-time compare) into the same inbound handler, replies out through the Spectrum SDK from a node action. Its free tier texts only numbers registered to the project, so email is how anyone else can try it. |
| **CALL-E** | The same questions on a real telephone. One `POST /v1/calls` carries the script the tools wrote and a strict `result_schema` whose violation enum holds only the numbers this person was asked about, under an idempotency key. Its webhook is unsigned, so it is believed for one thing, a call id, and the call is then read back from CALL-E's API with our own key. The transcript is shown in the thread that asked and read a second time by GPT-6 Astra; only what both readers agree on is recorded. The number must be written by the person asking, is rung at most twice a day, and our tables keep a hash and four digits of it. |

### The two rules that decide correctness

**A model picks the tool. It does not decide what is true.** Every reply is written by the tool, in the service's own words. The tool that records an answer refuses a violation number the person was never asked about.

**Which repair a person means is decided by their own words.** The city's description is embedded when we ask; their sentence is embedded when they answer; a Convex vector index, filtered to their own address, says which question the words are nearest. If the model picked a different number and the gap is wide, nothing is recorded — we ask, with both conditions in the city's words. An answer with no number at all is placed the same way, instead of landing on whichever question is newest.

That one was found by running it, not by reading it. On 17 September the live inbox was sent *"the latch on the compactor closet door is still broken"* and filed it against **#19178388, the plexiglass at the building entrance**. The same sentence now comes back "Which repair do you mean?", listing four — two of them near-identical latch violations at the same compactor closet, where asking is the only honest answer. ([hackathon.md](hackathon.md), commit 629c295.)

---

## How it holds together

A one-minute cron ticks the sources; each due one runs as a scheduled action that fetches the file, diffs it, and commits in slices of 150 rows — a city file is bigger than one transaction — writing the observation, the current-row pointer and the change event together, so a half-finished cycle loses nothing. New sources start in shadow mode: observed and diffed, not emitted, until a quiet cycle promotes them.

The tenant loop has tables of its own. Every ask and every answer is a dated row, never merged into the city's. Provider circuit breakers, a kill switch, and daily caps on reads and model runs keep the whole thing inside a free plan through judging.

```
engine/      pure TypeScript, zero Convex imports: ten adapters, canonical hashing, the
             diff, matching, statutes, HPD's vocabulary, receipts, the CSV export
convex/      schema, crons, ingest (tick -> fetch -> commit), lookup, inbound mail and
             texts, the inbox agent, embeddings, attestations, digest, packs, breakers,
             HTTP routes, limits
src/         landing, receipts wall, employer and building pages, the private record
             page, the judge's tour, sign-in
tests/       convex-test: the tenant loop, the agent's tools, suppressions, Photon
scripts/     fixture tests on real government bytes, plus a copy lint over every
             user-facing string
data/        the fixtures those tests run on
```

**359 automated checks:** 148 engine, 111 receipt, 38 state, 10 wall, 9 markdown, and 43 convex-test tests covering the tenant loop, the agent's twelve tools, the phone call from CALL ME to the receipt (against a stand-in for CALL-E: nothing in a test can ring a telephone), the delivery-event suppressions, re-watching a building someone is asked about, the browser trial's fences (nothing mailed, never counted publicly, its own rate-limit rooms), a conversation's (words taken only while one our server started is open, priced by the clock), and the Photon endpoint — plus a copy lint that fails if a reader-facing string says "source", "snapshot", "crawler" or any other of our words instead of theirs.

## Running it

```bash
npm install
cp .env.example .env         # keys go on the deployment, not in the file
npx convex dev               # backend
npm run dev                  # site

npm run typecheck && npm run lint:copy && npm run test:engine && npx vitest run
```

Deployment env: `OPENAI_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`, `AGENTMAIL_INBOX_ID`, `FIRECRAWL_API_KEY`, `SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`. Optional: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `SPECTRUM_WEBHOOK_SECRET` for Photon; `OPENAI_AGENT_MODEL` to run the agent on something other than `gpt-6-astra`.

## Honesty notes

Every claim a receipt makes is checkable against the government URL it names, and the build log records the times we were wrong:

- the day a receipt invented "Virginia's WARN Act";
- the day "closed 13 restaurants" was thirteen citations of one closure;
- the day a backwards date range in Maryland's file read as compliance;
- the day Wisconsin's `?version=N` link parameter was read as a revision count — later confirmed wrong by Firecrawl's own git-diff, which showed those numbers moving while nothing else on the page did;
- the day replies moved onto the AgentMail component's send queue and failed in production, and were moved back within minutes;
- the day a tenant's words were filed against the wrong repair.

Each is in [hackathon.md](hackathon.md), with the commit that fixed it.
