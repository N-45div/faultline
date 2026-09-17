import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { INBOX, mailto } from "./Pricing";
import AskCard, { SAMPLE_ASK } from "./AskCard";

// The tour. Nothing here is a screenshot: every number on this page is read
// from the deployment at the moment the page is open, and every button sends
// a real email to the real inbox.

const PUBLISHER: Record<string, string> = {
  "ny-warn": "New York",
  "ca-warn": "California",
  "va-warn": "Virginia",
  "nj-warn": "New Jersey",
  "wi-warn": "Wisconsin",
  "md-warn": "Maryland",
  "nc-warn": "North Carolina",
  "co-warn": "Colorado",
  "nyc-hpd": "NYC housing",
  "nyc-restaurants": "NYC restaurants",
};

// The count from the last full read; a "304 unchanged" is not an empty file.
const rowsOf = (s: { rowCount?: number; lastStatus?: string }) => {
  if (s.rowCount) return s.rowCount;
  const m = /(\d[\d,]*) rows/.exec(s.lastStatus ?? "");
  return m ? Number(m[1].replace(/,/g, "")) : 0;
};
const unchanged = (s: { lastStatus?: string }) => /304/.test(s.lastStatus ?? "");
// "Last verified" means something only if it can also say "not lately".
// A file not read in six hours, or whose last read failed, is marked so.
const STALE_MS = 6 * 3_600_000;
const stale = (s: { lastRunAt?: number; lastStatus?: string; consecutiveFailures: number }) =>
  !s.lastRunAt || Date.now() - s.lastRunAt > STALE_MS || s.consecutiveFailures > 0;

function ago(ms?: number): string {
  if (!ms) return "not yet";
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} ${h === 1 ? "hour" : "hours"} ago`;
}

export default function Judge({ go }: { go: (p: string) => void }) {
  const sources = useQuery(api.sources.status, {});
  const guard = useQuery(api.breaker.status, {});
  const ny = useQuery(api.wall.layoffNotices, { slug: "ny-warn" });
  const b = useQuery(api.wall.buildings, {});
  const pulse = useQuery(api.wall.housingPulse, {});
  const sample = useQuery(api.lookup.employer, { q: "spirit airlines" });
  const r = sample?.receipt;

  const files = sources?.filter((s) => s.emit) ?? [];
  const held = files.reduce((n, s) => n + rowsOf(s), 0);
  const freshest = files.reduce((t, s) => Math.max(t, s.lastRunAt ?? 0), 0);

  return (
    <>
      {guard && (!guard.mail || !guard.model || guard.paused.length > 0 || guard.breakers.some((b) => b.openUntil)) && (
        <p className="fine error" role="status">
          {!guard.mail && "Outgoing mail is not set up here: receipts are stored, not sent. "}
          {!guard.model && "The model is not set up here: letters are read without it, and the search says so. "}
          {guard.paused.length > 0 && `Paused by hand: ${guard.paused.join(", ")}. `}
          {guard.breakers
            .filter((b) => b.openUntil)
            .map((b) => `${b.provider === "openai" ? "The model" : "Outgoing mail"} is switched off until ${new Date(b.openUntil!).toUTCString().slice(17, 22)} UTC after repeated failures. `)}
          Nothing is dropped: mail waits in the queue and receipts say when we didn't look.
        </p>
      )}
      <p className="crumbs">
        <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }}>← Faultline</a>
      </p>

      <section className="tour-intro">
        <p className="kicker">For judges · eight minutes · sign-in only for step 10</p>
        <h1 className="lede-title">The landlord told the city it's fixed. Faultline asks the person living with it.</h1>
        <p className="lede-sub">
          Ten public files, read on a schedule and kept whole because the agencies overwrite theirs, and one question
          the city's file cannot answer, asked of the people who can. AgentMail is the front door, GPT-6 Astra on the
          OpenAI Agents SDK reads what people write back, and Firecrawl reads the one state page that needs a browser.
          Everything below is live: the numbers are Convex queries rendered as you look, and every button sends a real
          email.
        </p>
      </section>

      <section className="tour-step">
        <span className="num">1</span>
        <h2 className="h2">They marked it fixed. Is it? Email ASK and an address.</h2>
        <p>
          When an owner certifies a repair to HPD, the violation closes after 70 days unless HPD reinspects, and a tenant
          may challenge the certification to trigger that inspection. The city's file holds the owner's word; it has no
          place for the tenant's.
          Email <strong>{SAMPLE_ASK}</strong> and within seconds you get each repair the owner certified there that is
          still inside its 70 days, in the city's words, with the day they run out.
        </p>
        <AskCard go={go} className="mail-card tour-card" />
        {pulse && (
          <p className="fine">
            In the last 30 days owners certified {(pulse.onTime + pulse.late).toLocaleString()} repairs citywide, and the
            city stamped {(pulse.falseCert + pulse.invalidCert).toLocaleString()} certifications FALSE or INVALID —
            different violations, not a rate —{" "}
            <a href={pulse.url} target="_blank" rel="noreferrer">
              the city's own query
            </a>
            .
          </p>
        )}
        <p className="tour-ctas">
          <a className="cta primary" href={mailto(SAMPLE_ASK)}>
            Email "{SAMPLE_ASK}"
          </a>
          <a className="cta" href="/b/3050840061" onClick={(e) => { e.preventDefault(); go("/b/3050840061"); }}>
            See the building's record →
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">2</span>
        <h2 className="h2">Answer in your own words. The model picks a tool; the tools write the reply.</h2>
        <p>
          A reply with a number and FIXED, STILL BROKEN or NOT SURE is read with no model at all. Reply the way you'd
          tell a neighbour — "the tiles by the compactor are still cracked" — and GPT-6 Astra, on the OpenAI Agents SDK,
          reads it and must finish by calling one of the service's own tools: record an answer, ask about a building,
          look up a record, keep a page you send, look over the open web for an owner or an employer and hold what it
          finds, put the evidence pack or the filings spreadsheet in the thread, hand a
          pasted letter to the letter reader, or ask which one you meant. It writes no sentence
          you read. The tool that records an answer refuses any violation number this person was not asked about and
          asks them which repair they mean instead, so the model can pick the wrong tool but cannot put an answer on a
          repair nobody asked about.
        </p>
        <p>Try it: when step 1's reply arrives, answer it in a sentence.</p>
        <p className="fine">
          Eleven tools with strict schemas, tool choice required, one call at a time, low reasoning effort, at most six
          turns, and free moderation first. Four of them are the components: send a link and Firecrawl reads the page,
          which is kept as it was served with a picture of it and a checksum; name an owner or an employer and Firecrawl
          looks over the open web, lists every page that names them, and holds the first one the same way; ask for proof
          and the evidence pack or the filings spreadsheet arrives attached to the thread. You can have the first two
          without writing to the agent at all: email KEEP and a link, or FIND and a name, and the receipt comes back
          with the checksum of the copy we hold. Each run's tokens are priced into a ledger — about two and a half cents a
          message on the live inbox — under a daily cap; past the cap, or with the model unavailable, the keyword
          reader answers instead. The same inbox takes a reply by text through Photon.
        </p>
      </section>

      <section className="tour-step">
        <span className="num">3</span>
        <h2 className="h2">Your record: your word beside the city's, and what became of every reply.</h2>
        <p>
          Every ASK reply links to a private page: each repair you were asked about, what the city's file said when we
          asked and what it says now, HPD's 70 days, and what you said, each dated, with your photo if you sent one.
          Under it, every reply we sent you and what became of it — "Delivered to your inbox", "Bounced", "Sent by
          text" — from AgentMail's own delivery events. The AgentMail component verifies them and hands each one to a
          mutation that marks the reply's receipt.
        </p>
        <p className="fine">
          The link in the email is the only way in. Nothing on the page is sent to HPD or shown on a public page.
        </p>
      </section>

      <section className="tour-step">
        <span className="num">4</span>
        <h2 className="h2">The city's second word.</h2>
        <p>
          When HPD later stamps that certification FALSE or INVALID, the person who answered is told, with both dates:
          "The city agrees with you: HPD stamped #… FALSE CERTIFICATION on …. You said still broken on …; both dates
          are on your record." Only then does the public building page show that someone said so first, and never in
          their words.
        </p>
        <p className="fine">
          Answers live in their own Convex table, never merged into the city's row. HPD can take the full 70 days to
          reinspect, so the whole loop — ask, answer, the city's second word, the email that follows — also runs end
          to end in convex-test.
        </p>
      </section>

      <section className="tour-step">
        <span className="num">5</span>
        <h2 className="h2">Buildings — the city's own stamp, kept.</h2>
        <p>
          New York City stamps a landlord's "it's fixed" as FALSE CERTIFICATION, in those words, then overwrites the
          record.{" "}
          {b && b.buildings > 0
            ? `We hold ${b.records.toLocaleString()} records across ${b.buildings} buildings and keep the version each change replaced.`
            : "We keep the version each change replaced."}
        </p>
        <p className="tour-ctas">
          <a className="cta" href={mailto("107 East 126 Street, Manhattan")}>
            Email a building address
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">6</span>
        <h2 className="h2">Send a company name. Two dates and one statute, never a verdict.</h2>
        <p>
          Email <strong>{INBOX}</strong> with a company name as the subject. Within about twenty seconds you get the
          filing back in the same thread: the dates, the gap against the statute, the state's own page, and the day
          we captured it.
        </p>
        {r && r.kind === "layoff" && (
          <div className="mail-card tour-card">
            <div className="mail-head">
              <span className="dot" />
              <span>
                <strong>Re: Spirit Airlines</strong> · what the reply says right now
              </span>
            </div>
            <div className="mail-body">
              <p>
                <strong>{r.headline}</strong>
              </p>
              {r.blocks.slice(0, 1).map((blk) => (
                <p key={blk[0]}>
                  {blk.map((line, j) => (
                    <span key={line}>
                      {line}
                      {j < blk.length - 1 && <br />}
                    </span>
                  ))}
                </p>
              ))}
            </div>
          </div>
        )}
        {ny && (
          <p>
            In New York's file right now, <strong>{ny.underStatute} of {ny.total}</strong> notices gave less than the{" "}
            {ny.statutoryDays} days the law sets, and {ny.zeroDays} were dated the day the layoff began or after it. We
            say "gap", never "illegal": employers can claim exceptions, and that is a lawyer's call.
          </p>
        )}
        <p className="fine">
          The notice date is the employer's; the posting date is the state's. We keep them apart, so a state's slow
          posting is never pinned on an employer.
        </p>
        <p className="tour-ctas">
          <a className="cta primary" href={mailto("Spirit Airlines")}>
            Email "Spirit Airlines" now
          </a>
          <a className="cta" href="/e/spirit-airlines" onClick={(e) => { e.preventDefault(); go("/e/spirit-airlines"); }}>
            Or see the same receipt on the web →
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">7</span>
        <h2 className="h2">Paste the letter you were given. It sits beside what they filed.</h2>
        <p>
          A pasted or attached termination letter is read once by gpt-5.6-luna with a strict schema — the reason in
          the letter's own words, the dates, the days given to sign a release, and whether the OWBPA list of ages
          that a group termination must include for anyone over 40 came with it. The result is cached by the
          letter's content hash, so a re-forwarded letter costs nothing, and every call is priced in cents in a
          ledger. Free moderation screens the text first.
        </p>
        <p className="tour-ctas">
          <a
            className="cta"
            href={mailto(
              "my letter",
              "Dear team member, we regret to inform you that due to unforeseeable business circumstances, Spirit Airlines must eliminate your position at our LaGuardia operation. Your employment will end effective September 15, 2026. This letter is dated August 20, 2026. You are offered six weeks of severance pay, contingent on signing the enclosed release within 45 days. A disclosure listing the job titles and ages of all employees selected and not selected is attached.",
            )}
          >
            Send a sample letter
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">8</span>
        <h2 className="h2">What they said in public, beside what they filed.</h2>
        <p>
          On any employer's page, one button runs a single capped web search and returns the employer's own dated
          words with clickable citations, beside the reason the state recorded — for Spirit Airlines, "Bankruptcy
          Economic" on a notice dated the day the closure began. If the search finds nothing the page says so, because
          "we didn't look" and "we looked and found nothing" are different answers.
        </p>
        <p className="tour-ctas">
          <a className="cta" href="/e/spirit-airlines" onClick={(e) => { e.preventDefault(); go("/e/spirit-airlines"); }}>
            Open the employer page and press "Search what they said" →
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">9</span>
        <h2 className="h2">Every version is kept, because the states overwrite theirs — read it like a repository.</h2>
        <p className="tour-ctas">
          <a className="cta primary" href="/files" onClick={(e) => { e.preventDefault(); go("/files"); }}>
            Open the commit logs: every read a commit, every edit a before and after, every deletion kept →
          </a>
        </p>
        <p>
          {files.length > 0 ? `${files.length} government files are` : "Government files are"} read on a schedule. Each
          row is hashed on the fields that matter and compared with the last version, so a page that reshuffles its
          HTML produces zero false changes — and a date that moves produces exactly one. New Jersey publishes the month
          it posted a notice and never the day, so its receipts say so instead of counting a notice period the file
          cannot support.
        </p>
        <p>
          Wisconsin's page builds its tables with its own scripts, so Firecrawl reads it after they run. Each read also
          asks Firecrawl for its own change tracking against its previous capture, with the lines it saw move, and a
          full-page screenshot. A commit page shows Firecrawl's reading beside ours, including when the two disagree: on
          15 September Firecrawl called the page changed, and our row-by-row reading found that no notice had.
          Firecrawl's own lines show what moved: only the version numbers on the state's PDF links, which changed between
          two reads half an hour apart, and which we no longer quote.
        </p>
        {sources && (
          <ul className="tour-files">
            {files.map((s) => (
              <li key={s.slug}>
                <strong>{PUBLISHER[s.slug] ?? s.slug}</strong>
                <span>{rowsOf(s) > 0 ? `${rowsOf(s).toLocaleString()} rows` : "—"}</span>
                <span className={stale(s) ? "stale" : "muted"}>
                  {unchanged(s) ? "checked" : "read"} {ago(s.lastRunAt)}
                  {unchanged(s) ? ", unchanged" : ""}
                  {stale(s) ? " · not verified lately" : " · verified"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {held > 0 && (
          <p className="fine">
            {held.toLocaleString()} records held across {files.length} files; the freshest read was {ago(freshest)}.
            {b && b.since ? ` Versions kept since ${b.since}.` : ""}
          </p>
        )}
      </section>

      <section className="tour-step">
        <span className="num">10</span>
        <h2 className="h2">Reply FOLLOW, or follow from the web with Convex Auth.</h2>
        <p>
          A change to anything you follow queues one line for you, sent at most once a day, and the first arrives
          within a minute. If the send fails the news goes back in the queue and the next pass retries in a fresh
          thread. Reply STOP and nothing more arrives — STOP is honoured before every other rule, including the ones
          that ignore robots.
        </p>
        <p>
          Sign-in is email and password through Convex Auth — no outside provider, and nothing else on the site needs
          it. Make an account, open any employer, press "Follow this filing", and it appears under "What you follow"
          the same second, from a live query. Email alerts go only to an address that has written to the inbox itself,
          so nobody can sign up as you and have us mail you.
        </p>
        <p className="tour-ctas">
          <a className="cta" href="/signin" onClick={(e) => { e.preventDefault(); go("/signin"); }}>
            Create an account →
          </a>
          <a className="cta" href="/e/spirit-airlines" onClick={(e) => { e.preventDefault(); go("/e/spirit-airlines"); }}>
            Then follow Spirit Airlines →
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">11</span>
        <h2 className="h2">Ask for the evidence pack.</h2>
        <p>
          Email <strong>PACK Spirit Airlines</strong> and a PDF arrives in your thread within a minute: the record as
          it stands, every dated version with its capture time and hash, the changes we recorded, the statute with
          its exceptions, and how the capture works. Built in a node action, stored in Convex file storage, served
          from a tokenised link, attached to the reply.
        </p>
        <p className="tour-ctas">
          <a className="cta primary" href={mailto("PACK Spirit Airlines")}>
            Email "PACK Spirit Airlines"
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">12</span>
        <h2 className="h2">Under the hood, in one paragraph.</h2>
        <p>
          Convex: schema, indexes, full-text search, queries, mutations, actions, node actions, HTTP actions, crons,
          scheduled functions, file storage, realtime queries, Convex Auth, static hosting, and three components —
          AgentMail, which verifies the inbox's events, stores each once, and hands us inbound mail and delivery
          reports; Firecrawl; and the rate limiter, which holds one counter for each ceiling the inbox keeps instead of
          counting a table that only grows. A read is a start, then slices of 150 rows, then a finish, because a city file is
          bigger than one transaction. Two states rename their file on every publish, so the read takes today's link
          from the state's own page. AgentMail's delivery reports are acted on, not only recorded: a bounce or a spam
          complaint stops the mail and takes the follows off with it, and every message is labelled in the inbox with
          how it was read and what came of it, so what is still unread there is what nothing has handled. OpenAI: GPT-6
          Astra on the Agents SDK with eleven strict tools for the inbox;
          gpt-5.6-luna with one zod schema for both strict output and validation, a byte-stable cached prefix, and PDF
          and image input for letters and photographed notices; hosted web search; free moderation. Photon: a signed
          endpoint and the Spectrum SDK in a node action, so the same loop works by text — its free tier texts only
          numbers registered to the project, so judges use email.
        </p>
        <p className="fine">
          The build log is in the repository as hackathon.md, one entry per commit, corrections included.{" "}
          <a href="https://github.com/N-45div/faultline" target="_blank" rel="noreferrer">
            github.com/N-45div/faultline →
          </a>
        </p>
      </section>
    </>
  );
}
