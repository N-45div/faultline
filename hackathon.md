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
- **Auth:** Convex Auth (email + password; Google once a client id is set), optional everywhere
- **AI models:** gpt-5.6-luna (strict structured outputs, prompt caching, PDF file input, hosted web search), omni-moderation-latest
- **Started:** 2026-08-29T18:42:23Z
- **Last updated:** 2026-09-03T00:35:00Z

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

### 2026-09-02 - 0e2ca6f
The wall became a demo surface. A city cycle had moved nine violations at one
Queens building and the wall showed nine near-identical routine lines with
every state's news buried underneath. Changes are now grouped at write time —
"11 violations at 773 Concourse Village East moved to NOV SENT OUT (8 class B,
3 class A)" — and ranked: a layoff filing or the city's FALSE CERTIFICATION
stamp outranks a status that moved, which outranks "will be reinspected". No
one publisher may take more than eight of the thirty lines on show. The
grouping is a pure engine function with its own test, and because the wall is
only a cache of the changes table it can be rebuilt from the truth at any time.

The judge path: `/judge` walks a reader through the product in nine steps with
no sign-in and nothing in front of it. Every number on it is read from the
deployment as the page is open — the seven files, their row counts, how long
ago each was read, the statute stat — and every button sends a real email to
the real inbox.

Sign-in, pulled forward from tomorrow and optional everywhere: email and
password through Convex Auth, with Google appearing only once the deployment
holds a client id, because a button that exists and fails is worse than none.
It unlocks exactly the two things a stranger cannot have — following a filing
from the web without an email thread, and seeing what you follow. A web follow
goes into the same subscriptions table the inbox writes to and reaches the
person through the same one-a-day digest. Proven headlessly against the
deployment: sign-up issues tokens, a signed-in follow lands, an anonymous
follow is refused, a wrong password is rejected. Convex features: Convex Auth,
auth tables, HTTP routes ahead of the static catch-all, `getAuthUserId` in
queries and mutations (`convex/auth.ts`, `convex/follows.ts`, `engine/wall.ts`,
`src/Judge.tsx`, `src/SignIn.tsx`).

### 2026-09-02 - 617faf6
Two research passes and the fixes they forced. A product review from the seats
of a lawyer, a tenant organiser and a five-minute judge found twelve defects;
the ones a reader would hit first are fixed: a multi-state employer's receipt
named one state and linked to one state's page while listing another's
workers (Crothall Healthcare now reads "4 filings in Virginia and Maryland,
884 workers, 2018–2026", each filing prefixed with its state, one link per
state); the evidence pack silently covered only New York and California and
printed those two statutes for everyone (now all six files, one statute
paragraph per state the employer filed in); the tour showed "California 0
rows" after every 304 (the source now carries its last full count); every
tab said "Faultline"; the wall said "1 workers" and spent its lines on one
employer's seven sites; "Search what they said" reported nothing found when
the truth was the daily allowance. A market scan of everything adjacent —
WARNTracker at $250 a month, WARN Firehose, Layoff Lookout, JustFix — found
nothing that keeps versions or diffs, computes the state statute gap, or
touches New York City, and rewrote the rest of the plan around three things
none of them do: the amendment chain, the dated "nothing filed" receipt, and
the 30/90-day aggregation line.

Google sign-in is live: Divij created the client in the console (the IAP
OAuth Admin API that used to allow this from the CLI was shut down in March
2026), the button appears only because the deployment holds the client, and
the flow was traced to Google's door — correct client id, correct callback,
scopes openid profile email. Privacy and terms pages, in plain words, because
Google requires them and a product that reads termination letters should have
had them anyway. The navigation bar became three zones — where you are, what
you can look up, who you are and how to reach us — with a search that works
from any page, an address that copies itself, an account menu, and a phone
sheet. Payments are dropped for the hackathon.

### 2026-09-03 - ec05bfa
The sentence-one claim, made countable. Every employer and building page now
carries "Versions we hold": each row, when it was first and last captured,
how many versions, its current hash, and the changes recorded — all read back
from what ingest wrote. Every receipt ends with two lines a lawyer forwarding
it would otherwise have to ask for: "We hold 1 row for this, in 1 version,
and have read the file 97 times since 2026-08-29", and "Read from New York's
file on 2026-09-02 18:30 UTC (HTTP 200, 193 rows)" with the URL. A building
with seventeen live violations was headlined "no certification stamps"; it
now reads "17 violations on record (2 class C, 12 class B, 3 class A)", the
stamps first when there are any, each violation in the city's own words for
what was wrong. And a person who asked about a building we did not hold gets
the real receipt into the same thread once the city answers, instead of being
told to ask again. Convex features: queries over observation and snapshot
indexes, scheduled functions with retry (`convex/lookup.ts`,
`src/Versions.tsx`, `engine/receipt.ts`, `convex/inbound.ts`).

### 2026-09-03 - cecb314
Pulled forward from 4 September: the two things no tracker does. The
amendment chain — states edit notices in place, and the receipt now spells out
which field moved, from what to what, the day we caught it, and that the
version before is kept; when a start date moves later, the federal rule sits
beside it as a rule, never a verdict. Proven with a real diff over real bytes.
And the receipt for nothing filed: dated to the minute, each file's last read
and row count, a note that every read is a hashed copy so the absence is
itself on the record, and followable — reply FOLLOW to a name and ingest
matches every newly added row's employer against it. Convex features: change
events with before/after read back into receipts, name-keyed subscriptions
matched at ingest (`engine/receipt.ts`, `convex/lookup.ts`,
`convex/ingest/write.ts`).

### 2026-09-03 - e7baf7c
Pulled forward from 5 September. The aggregation line: federal rules count
separate layoffs at one site within any 90-day period together, and every
state file shows them as unrelated rows — the receipt now says "3rd notice at
this address in 13 days; 346 workers across them", matched by state and
address exactly as the state wrote them, so the count is never inflated. And
the exception line, only when notice fell short of the statute: what reason
the state's file records, whether those words name an exception the rule
allows ("Bankruptcy Economic" names none; "Unforeseen Business Circumstances"
names one, and the rule also requires the notice to state the basis), or that
the file records no reason at all — the record, never a verdict. Also one
FOLLOW line on the nothing-filed receipt instead of two. All three are pure
engine functions with fixture tests (`engine/receipt.ts`,
`scripts/receipt-test.ts`).

### 2026-09-03 - fe30c6d
Found while checking the aggregation line on production: "Martin's" — eleven
Virginia filings — came back as nothing filed. The full-text index splits an
apostrophe into "martin" and "s"; our query joined it to "martins", so the
state's own spelling never matched. The index now gets the terms the way it
tokenises them, plus the stem of a possessive typed without its apostrophe
("McDonalds" finds McDonald's Corporation). Recall only — ranking still scores
the raw query against the raw label (`engine/match.ts`, `convex/lookup.ts`).

### 2026-09-03 - b884261
Three items from the 2 September review. The corroboration search costs
money and its action is public, so it now buys only for a filing we hold —
the employer and notice date exactly as a state's file has them; a stranger
with the URL cannot spend the day's budget on names of their own. One page
per employer: the employer query returns the canonical slug and the page
settles on it, so "spirit", "spirit-airlines" and "spirit-airlines-llc" are
one URL for bookmarks and shares. And the "Close matches" links use the same
slug helper as every other link (`convex/corroborateData.ts`,
`convex/corroborate.ts`, `convex/lookup.ts`, `src/Employer.tsx`).

### 2026-09-03 - 1c32581
Pulled forward from 6 September. A link to an employer or a building pasted
into a chat is unfurled by a crawler that runs no JavaScript, so `/e/` and
`/b/` are now HTTP routes that fetch the app shell from the static host and
put the receipt's own words in the head: the headline as the title, the
first lines as the description, the canonical slug as the URL. Same shell,
same app, no second build; a miss falls back to the plain page. Convex
features: HTTP actions above the static catch-all, running the same public
queries the page uses (`convex/http.ts`).

### 2026-09-03 - 16af582
Pulled forward from 7 September, because a demo that dies during judging
week is the only failure that counts. A kill switch: one deployment
variable, `NOTICE_PAUSE=mail|ingest|llm|all`, read at the top of every path
that sends or spends — paused mail waits in the queue, a paused read is
picked up at the next tick, a paused model answers "we didn't look". Circuit
breakers for the two paid providers: three failures in a row open the
breaker for fifteen minutes, callers do not try while it is open and say so,
one success closes it. "Last verified" on the tour now also says "not
verified lately" in red when a file has not been read in six hours or its
last read failed, and a banner names anything switched off. Evidence-pack
PDFs expire after thirty days (the rows behind them do not; a fresh PACK
rebuilds it). And a copy lint over every string a person can read, which
found two "you watch" on its first run. Chaos test on the dev deployment:
model name pointed at nothing, three letters in, breaker open, corroboration
answers "off", one success and it is closed again. Convex features: a
breakers table behind internal query/mutation, daily cron for GC, env read
per execution as the switch (`convex/guard.ts`, `convex/breaker.ts`,
`convex/packs.ts`, `convex/crons.ts`, `src/Judge.tsx`,
`scripts/copy-lint.ts`).

### 2026-09-03 - 600a688
The eighth file, and the most revealing one. New Jersey publishes its whole
WARN archive as a single spreadsheet, one sheet per year back to 2004,
overwritten in place — 2,367 filings. It also publishes no notice date. Every
other state prints the date the employer's notice bears; New Jersey prints
the month it posted the notice, "September", and nothing else. So the one
number this product exists to compute cannot be computed there, and the
receipt says exactly that: "Posted by New Jersey in February 2025. Layoff
started 2025-04-24. New Jersey publishes the month it posted a notice, not
the date the employer gave it, so the notice period cannot be counted from
the state's file. New Jersey's own WARN Act sets 90 days, and since April
2023 severance of a week per year worked." The rule is named, never scored.
The gap rule itself now returns "unknown" rather than zero when a date is
missing, because zero days' notice is a claim about an employer; a filing
that cannot be counted sorts last, not first; and the explanation is given
once per state rather than on all eleven of an employer's filings. The
effective-date cell is a date, or a range, or a list of twelve dates, or
"Rolling basis beginning on 6/4" — the first real date is kept and the cell
as written is kept beside it. A sheet footnote that named no place, no date
and nobody is no longer ingested as an employer. Brought up on production
through the same shadow-mode gate as the other seven: two cycles, second one
zero changes, then promoted. Eight files, 8,026 rows.

### 2026-09-03 - 9380681
A pass back over everything shipped today, hunting the receipt's own honesty
first. One real bug: the exception line matched a state's recorded reason on
the first word of each statutory exception, so Colorado's free text — "natural
gas plant shutdown" — would have been reported as naming the natural-disaster
exception. Claiming an employer invoked a legal exception they never invoked
is the worst thing this receipt could do; matching is now on the phrase, with
the disasters named, and the cases are in the tests. Two smaller ones: the
public status query returned the provider's own error text to anyone who
asked — that is diagnostics, it belongs in the logs — and a signed-in account
could follow without limit, now capped at 500. And New Jersey's month is no
longer listed as a significant field, because it is part of the row's
identity and could never have emitted a change from there (`engine/receipt.ts`,
`convex/breaker.ts`, `convex/follows.ts`, `engine/adapters/njWarn.ts`).

### 2026-09-03 - 183db33
Six independent adversarial reviews — money and abuse, receipt correctness,
concurrency, the web app, honesty of every claim, operational fitness — each
required to trace a finding to a concrete failing input. Two of them
independently found the same two worst things, which is how I knew they were
real.

**The receipt was stating a law that does not exist.** "Virginia's WARN Act
sets 60 days" — Virginia has no WARN act; the federal 60 days is the whole
rule, as this repo's own comments say. Colorado and North Carolina the same.
The evidence pack contradicted itself inside one document: section 1 named
Virginia's act, section 4 said Virginia has none. One `OWN_ACT` map now
answers that question for the receipt, the change sentences and the PDF.

**The "nothing filed" receipt claimed total coverage.** "We hold every layoff
notice New York, California, … have published" — but California's file is a
rolling window (155 rows, two months), and Maryland, Colorado and North
Carolina publish one calendar year. On the one receipt whose entire value is
a negative, the scope of that negative was false. It now says what each file
covers, per file, next to that file's row count.

**Yesterday's canonical-slug change broke found receipts.** `slug("Martin's")`
is "martin-s", which the matcher cannot read back, so /e/martins showed
eleven Virginia filings and then rewrote its own URL into "we couldn't find
it". A separate `urlSlug` drops apostrophes (the database keys, which slug()
mints, are untouched), and the web now shares one implementation with the
server instead of a second copy.

**Spirit Airlines had been split in two** by New Jersey's arrival: "Spirit
Airlines" and "Spirit Airlines, LLC" were different employers, so the tour's
own example page had lost the New York filing it describes. Names that differ
only by a legal suffix are one employer now; "Amazon" and "Amazon Web
Services" still are not.

Also: a caller-supplied "stated reason" reached the search prompt and was
published as an employer's words — it now comes from the filing we hold; the
provider breakers no longer trip on faults that are ours (a 400 we caused, a
404 on a dead thread), so three bad requests can't switch the model off for
everyone; held mail is re-scheduled rather than dropped, which is what the
kill switch always claimed; the share route's shell fetch is inside its try
with a timeout, so a static-host hiccup degrades instead of 500ing every
employer page; `$&` in a query can no longer break out of a meta tag; pack
expiry no longer stalls behind its first hundred rows; prices are out of
everything we email (a rate card makes it commercial mail, which needs the
postal address we deliberately don't have); California's *processed* date is
no longer reported as the day the state published; the 90-day aggregation
only fires where the state publishes an actual street address, not a
workforce region; and the employer page remounts per employer, so one
company's public statement can never appear under another's filing.

### 2026-09-03 - e0c1ec1
The rest of what the six reviews found, verified one at a time.

A 13-worker filing was being scored against the statute — "Maryland's
Economic Stabilization Act sets 60 days", then a paragraph about which
exceptions the rule allows. Maryland's own log says it lists dislocations
that meet no threshold at all, so that read as an accusation the record
cannot support. Below the federal headcount the receipt now says so and
withholds the statutory paragraph.

Alerts were being read table-wide and capped: past the cap, whoever sorted
late simply stopped being told, and a busy building could silence a follower
of a quiet employer for good, because the changes commit in the same
transaction and are never re-derived. Followers are now looked up per subject
and the cap is per person. The digest had the same shape of bug: one
recipient with a backlog larger than the window owned the whole window
forever, so nobody else was ever looked at.

`sources.runNow` cleared the per-source lock, which is how two cycles of one
source could overlap and write every row twice — the incident already in this
log on 31 August. It now only makes a source due. A 200 that parses to zero
rows is treated as a failed read instead of updating the timestamp and
keeping the old row count, which had let a broken file read as "97 rows,
verified" on the tour. And the kill switch now covers the on-demand city
pull, and rejects a token it does not recognise instead of announcing a pause
that is not in effect.

Smaller: "read 97 times since" had lost its date; a notice dated after the
layoff began no longer renders as "-37 days" on the wall or the landing page;
Google sign-in failure says something instead of looking like a dead button;
the tour describes what its example page shows rather than promising a
particular search result.

Not fixed, and why: making `FIRECRAWL_API_KEY` optional breaks the build —
the component itself requires it — so the right fix is removing a component
nothing uses, which is not a thing to do during judging week.

### 2026-09-03 - 45663ed
The last of the money findings. The daily search cap was read in an action and
written ten seconds later, once the call returned — so any number of
concurrent callers all read zero and all spent. A slot is now claimed in a
mutation before anything is bought, which Convex serialises, and released
again if the call fails. And corroboration no longer counts against the
letter-reading budget: a burst of public search calls could take the thing
people actually email us for offline for a day (`convex/corroborateData.ts`,
`convex/corroborate.ts`, `convex/llm.ts`).

### 2026-09-03 - 39e1d39
The last correctness finding from the six reviews, and the one that had the
worst failure mode. Maryland writes start dates as ranges and sometimes
writes them backwards — "03/31/2026 - 06/30/2025" — and measuring to the
first date in the cell turned the largest gap in Maryland's file into "60
days' notice — inside the 60 days". New Jersey writes lists: "3/31/26
(Paramus and Ramsey), 4/30/26 (Livingston)", and the receipt stated 31 March
as the start for a Livingston worker whose own date the state had printed
right there.

A start date is now only counted when the cell holds one date, or a proper
range in order. Anything else — a list, a backwards range, two dates joined
by "and" — is the state saying more than one thing, and the receipt shows the
cell as written and declines to count a notice period from it. Both cases
verified against the real rows.

Also from the reviews: a subject's edits were read once per state per
subject, so the same rows were fetched seven times on a path anyone can call;
a name-follow that has never matched anything showed its internal key
("q:acme-corp") to the reader and linked to a dead page; the dev overview
died on the read limit, which is exactly when you reach for it; a pack built
twice left the first PDF in storage referenced by nothing; and a cycle that
deferred rows stored its etag anyway, so the next cycle asked "has it
changed?", got a 304, and left the deferred rows waiting for the state's next
edit.

### 2026-09-03 - a3f7c2b
The last security finding. Signing up takes any address and does not verify
it, so anyone could enter someone else's, follow a busy building from the
web, and have us mail a stranger every day — from our own sending inbox, with
a footer saying they had asked for it.

A follow that arrives by email is confirmed by the act of sending it. A
follow made on the web is confirmed only if that address has written to the
inbox before. Unconfirmed follows still work — they appear on the site and
under "What you follow" — they are simply never emailed, and the button says
so rather than promising mail that will not come. No confirmation message is
sent either, because a confirmation email to someone who never asked is the
same email the abuse would have produced.

Also settled: the reviews flagged that subject keys carry no jurisdiction, so
one employer at a same-named place in two states would merge — a follower of
one state's site getting the other's alerts. Checked against all seven files:
3,719 subject keys, none claimed by two states. The key format mints every
stored row, follow and subject, so changing it would orphan the lot; recorded
and left alone (`convex/schema.ts`, `convex/follows.ts`, `convex/digest.ts`,
`convex/inbound.ts`, `src/FollowButton.tsx`).

### 2026-09-03 - f1950c3
The ninth file, and the plainest case yet for why versions are the product.
The Health Department's restaurant inspection file says its own limits out
loud: it holds violations "up to three years prior to the most recent
inspection", for establishments "in an active status on the RECORD DATE", and
"only restaurants in an active status are included in the dataset". So when a
restaurant closes for good, its whole inspection history leaves the city's
file — and thousands open and close every year, in the department's own
words. That is not a claim we make about the city; it is the city's
description of its own dataset, quoted.

It is keyed on the same 10-digit parcel number HPD uses, so it lands on the
building pages we already have. 105 Bowery, live right now: no housing
violations on record, and underneath, "New York City closed LAO JIE HOTPOT
here on 2026-08-31", with the three citations in the city's own words. The
phone number in the file is read and dropped, like Virginia's named contact.

Two things this turned up. Unlike the housing file, this one is deliberately
read without a date filter — a building's *history* is the thing that
disappears, so the last three days of it is not what is worth holding. That
makes the first read large: 6,709 rows across 197 watched buildings, which
went through the deferral path in three cycles and proved the fix from
earlier today on production. And the receipt first said "closed 13
restaurants" at one address, because it counted citations rather than
restaurants — one closure is one restaurant on one day, however many
citations the city wrote that day.

Also from the plan and dropped, honestly: OATH hearings. The plan said
dismissed violations are removed from the property record. Its own
description does not say that, its location fields are blank on three
quarters of rows, and the hearing result is blank on nearly all of them —
it will not carry the claim, so it is not being built on one.

Nine files, 13,560 rows.

### 2026-09-04 - d5f0d8f
Pulled forward from 14–16 September, because it is the thing the ten outreach
targets would actually ask for. Email "CSV Spirit Airlines" and a file comes
back in the thread; on the web, every employer page has "Download every
filing as CSV". One row per filing: employer, state, site, workers, the
notice date, the layoff start as we parsed it and as the state wrote it, the
type and reason the state recorded, the days of notice against the statute
the filing falls under, the state's posting date, every in-place amendment
we caught with the day we caught it, and the state file it came from.

Two deliberate absences. There is no "limitations date" column, though the
plan listed one: federal WARN sets no limitations period, courts borrow the
most analogous state statute, and that differs by state and circuit — a
number in that column would be a legal determination dressed as data. And
days_of_notice is blank, never zero, where it cannot be counted: New Jersey
publishes no notice date, and a start date the state wrote as a list of five
is not a date.

The file is built in the same mutation that answers the email, where there
is no Buffer, so base64 is done by hand. The first real export showed New
Jersey's "as written" column carrying Excel's serial for a date cell — 46144
— which is nobody's idea of what the state wrote; a date cell is now a date,
and only text cells (ranges, lists) are kept verbatim (`engine/export.ts`,
`convex/lookup.ts`, `convex/inbound.ts`, `convex/http.ts`, `src/Employer.tsx`).

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
| 2 Sep | The wall as a demo surface (done); judge tour (done); sign-in + FOLLOW from the web (done, pulled forward). Still needs Divij: postal address, AgentMail Developer plan + custom domain, an Outlook address, a Google OAuth client |
| 3 Sep | Done: "Versions we hold" on every page; the held and provenance lines on every receipt; the building headline counts by class with the city's own words; the address pull writes back |
| 4 Sep | Done a day early: the amendment chain — when a state edits a notice in place (a moved effective date, a changed headcount, a rescission), the receipt shows before → after with both capture times, because a postponement past 60 days needs a fresh notice (Messer v. Bristol) and the diff is the claim; the dated "nothing filed" receipt — "as of <time>, no notice from X in the six files we hold, snapshots hashed" — with an alert when one appears |
| 5 Sep | Done two days early: the 30/90-day aggregation line per employer and site ("3rd notice from X at this address in 74 days, 61 workers cumulative") — the batching loophole workers describe, that no tracker computes; the exception line — where a state records the reason given, whether the employer named an exception (unforeseeable business circumstances, faltering company) beside their own public words; Google sign-in once the client id arrives |
| 6 Sep | Ten receipts to ten plaintiff-side firms and tenant organisers — the thirty-day test; employer share pages (done 3 Sep); AgentMail Developer plan + custom domain, warmup starts |
| 7 Sep | Judging-week protections done 3 Sep (breakers, "last verified" badges, kill switch, chaos test, pack GC, copy lint); left: a second adversarial review of everything shipped since 31 Aug |
| 8–10 Sep | New Jersey and NYC restaurant inspections DONE 3 Sep (the food file the city rebuilds from every pull). OATH dropped: its own description does not support "dismissed violations are removed", location is blank on 3/4 of rows, hearing result on nearly all. New Jersey DONE 3 Sep (2,367 filings; the state that publishes no notice date). Illinois PROBED 3 Sep and parked: its WARN list is an Angular app whose API (`/iebs/Apps/api/public/search`) 302s to a login for every request, and the department's own page offers only per-year PDFs — a source that would break in front of a judge. Left: Illinois (90/60-day laws, overwritten files); Wisconsin (dwd.wisconsin.gov does not resolve from this network at all — try from another network or from inside a deployment fetch before writing the adapter; the one state that publishes revision codes — the model for the amendment chain); the NYC feeds that are provably lossy where HPD is not: restaurant inspections (closed restaurants vanish) and OATH hearings (dismissed violations are removed from the property record) |
| 11–13 Sep | Firecrawl: HTML-only states and employer newsroom captures; share images; teaser post |
| 14–16 Sep | Lawyer export DONE 4 Sep (CSV by email and on every employer page; no limitations column, on purpose). Left: hardening — redaction, chaos test with keys removed (employer, site, notice date, first separation, count, exception text, amendments, limitations date) |
| 17–18 Sep | Video |
| 19–20 Sep | This file, final; posts; submission ready |
| 21 Sep | Freeze |
| 22 Sep | Submit before 12:00 PT |
