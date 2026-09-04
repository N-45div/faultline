import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { INBOX, mailto } from "./Pricing";

// The tour. Nothing here is a screenshot: every number on this page is read
// from the deployment at the moment the page is open, and every button sends
// a real email to the real inbox.

const PUBLISHER: Record<string, string> = {
  "ny-warn": "New York",
  "ca-warn": "California",
  "va-warn": "Virginia",
  "nj-warn": "New Jersey",
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
  const sample = useQuery(api.lookup.employer, { q: "spirit airlines" });
  const r = sample?.receipt;

  const files = sources?.filter((s) => s.emit) ?? [];
  const held = files.reduce((n, s) => n + rowsOf(s), 0);
  const freshest = files.reduce((t, s) => Math.max(t, s.lastRunAt ?? 0), 0);

  return (
    <>
      {guard && (guard.paused.length > 0 || guard.breakers.some((b) => b.openUntil)) && (
        <p className="fine error" role="status">
          {guard.paused.length > 0 && `Paused by hand: ${guard.paused.join(", ")}. `}
          {guard.breakers
            .filter((b) => b.openUntil)
            .map((b) => `${b.provider === "openai" ? "The model" : "Outgoing mail"} is switched off until ${new Date(b.openUntil!).toUTCString().slice(17, 22)} UTC after repeated failures. `)}
          Nothing is dropped: mail waits in the queue and receipts say when we didn't look.
        </p>
      )}
      <p className="crumbs">
        <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }}>← Notice</a>
      </p>

      <section className="tour-intro">
        <p className="kicker">For judges · five minutes, no sign-in</p>
        <h1 className="lede-title">An email address that answers with the public record.</h1>
        <p className="lede-sub">
          Everything below is live. The numbers are read from the deployment as you look at them, and every button
          sends a real email to a real inbox that writes back on its own.
        </p>
      </section>

      <section className="tour-step">
        <span className="num">1</span>
        <h2 className="h2">Send a company name. Get what they told the government.</h2>
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
        <span className="num">2</span>
        <h2 className="h2">Every version is kept, because the states overwrite theirs.</h2>
        <p>
          {files.length > 0 ? `${files.length} government files are` : "Government files are"} read on a schedule. Each
          row is hashed on the fields that matter and diffed
          against the last version, so a page that reshuffles its HTML produces zero false changes — and a date that
          moves produces exactly one. New Jersey publishes the month it posted a notice and never the day, so its
          receipts say so instead of counting a notice period the file cannot support.
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
        <span className="num">3</span>
        <h2 className="h2">Two dates and one statute. Never a verdict.</h2>
        {ny && (
          <p>
            In New York's file right now, <strong>{ny.underStatute} of {ny.total}</strong> notices gave less than the{" "}
            {ny.statutoryDays} days the law sets, and {ny.zeroDays} were dated the day the layoff began or after it. We
            say "gap", never "illegal": employers can claim exceptions, and that is a lawyer's call. We are the dated
            proof you bring them.
          </p>
        )}
        <p className="fine">
          The notice date is the employer's; the posting date is the state's. We keep them apart, so a state's slow
          posting is never pinned on an employer.
        </p>
      </section>

      <section className="tour-step">
        <span className="num">4</span>
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
        <span className="num">5</span>
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
        <span className="num">6</span>
        <h2 className="h2">Reply FOLLOW. Hear about it once a day, at most.</h2>
        <p>
          A change to anything you follow queues one line for you. A cron sends at most one email per person per
          day, and the first arrives within a minute. If the send fails the news goes back in the queue and the next
          pass retries in a fresh thread. Reply STOP and nothing more arrives — STOP is honoured before every other
          rule, including the ones that ignore robots.
        </p>
      </section>

      <section className="tour-step">
        <span className="num">7</span>
        <h2 className="h2">Buildings too — the city's own stamp, kept.</h2>
        <p>
          New York City stamps a landlord's "it's fixed" as FALSE CERTIFICATION, in those words, then overwrites the
          record.{" "}
          {b && b.buildings > 0
            ? `We hold ${b.records.toLocaleString()} records across ${b.truncated ? "at least " : ""}${b.buildings} buildings and keep the version each change replaced.`
            : "We keep the version each change replaced."}
        </p>
        <p className="tour-ctas">
          <a className="cta" href={mailto("107 East 126 Street, Manhattan")}>
            Email a building address
          </a>
        </p>
      </section>

      <section className="tour-step">
        <span className="num">8</span>
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
        <span className="num">9</span>
        <h2 className="h2">Under the hood, in one paragraph.</h2>
        <p>
          Convex: schema, indexes, full-text search, queries, mutations, actions, node actions, HTTP actions, crons,
          scheduled functions, file storage, realtime queries, static hosting; the AgentMail and Firecrawl
          components. Ingest is a snapshot, then slices of 150 rows, then a finish, because a city file is bigger
          than one transaction. Two states rename their file on every publish, so the transport reads the state's own
          page and takes today's link from it. OpenAI: the official SDK, one zod schema for both the strict output
          and validation, a byte-stable cached prefix, PDF file input, hosted web search, free moderation.
        </p>
        <p className="fine">
          The build log is in the repository as hackathon.md, one entry per commit.{" "}
          <a href="https://github.com/N-45div/faultline" target="_blank" rel="noreferrer">
            github.com/N-45div/faultline →
          </a>
        </p>
      </section>
    </>
  );
}
