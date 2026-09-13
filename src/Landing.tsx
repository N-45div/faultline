import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import Pricing, { INBOX, mailto } from "./Pricing";

// The front door. Everything numeric on this page is read live from the
// filings we hold — nothing here is typed in.

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export default function Landing({ go }: { go: (p: string) => void }) {
  const ny = useQuery(api.wall.layoffNotices, { slug: "ny-warn" });
  const log = useQuery(api.wall.changelog, {});
  const b = useQuery(api.wall.buildings, {});
  const pulse = useQuery(api.wall.housingPulse, {});
  const sample = useQuery(api.lookup.employer, { q: "spirit airlines" });
  const hero = ny?.shortest[0];
  const r = sample?.receipt;

  return (
    <>
      <section className="band hero-band">
        <div className="container hero-grid">
          <div>
            <h1 className="lede-title">The government overwrites its files. We keep every version we read.</h1>
            <p className="lede-sub">
              Email us a company name or a New York City address and get back what they filed — the dates, the gap
              against the law, the government's own page — including the versions the agency has since deleted.
              Ten public files, read on a schedule and kept like a repository: every read is a commit with a hash,
              every edit is a diff, and every deleted row is still here.
            </p>
            <div className="lede-ctas">
              <a className="cta primary" href={mailto("Spirit Airlines")}>
                Email {INBOX}
              </a>
              <a className="cta" href="/files" onClick={(e) => { e.preventDefault(); go("/files"); }}>
                See the commit logs →
              </a>
            </div>
            <p className="fine">
              Free. Nothing to install, nothing to sign up for. Reply FOLLOW to hear when a filing changes;{" "}
              <a href="/deleted" onClick={(e) => { e.preventDefault(); go("/deleted"); }}>see what is gone from its files</a>.
            </p>
            <p className="fine">
              Live in New York City? Email <a href={mailto("ASK ")}>ASK and your address</a>: when your landlord tells the
              city a repair is done, tell us whether it is, and keep your answer, dated.
            </p>
          </div>

          <div className="mail-card" aria-label="A real receipt">
            <div className="mail-head">
              <span className="dot" />
              <span>
                <strong>Re: Spirit Airlines</strong> · from Faultline, 20 seconds later
              </span>
            </div>
            {r && r.kind === "layoff" ? (
              <div className="mail-body">
                <p>
                  <strong>{r.headline}</strong>
                </p>
                {r.blocks.slice(0, 1).map((b) => (
                  <p key={b[0]}>
                    {b.map((line, j) => (
                      <span key={line}>
                        {line}
                        {j < b.length - 1 && <br />}
                      </span>
                    ))}
                  </p>
                ))}
                <p className="fine">{r.footer[0]}</p>
                <p className="fine">
                  <a href="/e/spirit-airlines" onClick={(e) => { e.preventDefault(); go("/e/spirit-airlines"); }}>
                    See the whole receipt →
                  </a>
                </p>
              </div>
            ) : (
              <div className="mail-body">
                <p className="muted">Reading the state's file…</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {log && log.since && (
        <section className="band">
          <div className="container">
            <p className="kicker">The changelog of government · since {log.since}</p>
            <div className="proof">
              <div>
                <p className="big">{log.deleted.toLocaleString()}</p>
                <p className="muted">
                  rows gone from a file we hold whole.{" "}
                  <a href="/deleted" onClick={(e) => { e.preventDefault(); go("/deleted"); }}>Still here →</a>
                </p>
              </div>
              <div>
                <p className="big">{log.edited.toLocaleString()}</p>
                <p className="muted">
                  rows edited in place, each with its before and after.{" "}
                  <a href="/files" onClick={(e) => { e.preventDefault(); go("/files"); }}>Before and after →</a>
                </p>
              </div>
              <div>
                <p className="big">{log.added.toLocaleString()}</p>
                <p className="muted">
                  rows added since we began holding the files.{" "}
                  <a href="/scorecard" onClick={(e) => { e.preventDefault(); go("/scorecard"); }}>The scorecard →</a>
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {ny && hero && (
        <section className="band">
          <div className="container">
            <p className="kicker">From New York's layoff file, right now</p>
            <div className="proof">
              <div>
                <p className="big">{ny.underStatute}</p>
                <p className="muted">
                  of {ny.total} notices gave less than the {ny.statutoryDays} days the law sets
                </p>
              </div>
              <div>
                <p className="big">{ny.postedAfterStart}</p>
                <p className="muted">were put online by the state after the layoff had already started</p>
              </div>
              <div>
                <p className="big">{hero.actualDays > 0 ? days(hero.actualDays) : "0 days"}</p>
                <p className="muted">
                  the shortest notice in the file
                  {hero.actualDays === 0
                    ? ", dated the day the layoff began"
                    : hero.actualDays < 0
                      ? `, dated ${-hero.actualDays} ${-hero.actualDays === 1 ? "day" : "days"} after the layoff began`
                      : ""}{" "}
                  — {hero.company}, {hero.workers} workers
                </p>
              </div>
              <div>
                <p className="big">{ny.zeroDays}</p>
                <p className="muted">notices dated the same day the layoff began, or after it</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {pulse && (
        <section className="band">
          <div className="container">
            <p className="kicker">They marked it fixed. Is it? · New York City, the last 30 days</p>
            <div className="proof">
              <div>
                <p className="big">{(pulse.onTime + pulse.late).toLocaleString()}</p>
                <p className="muted">repairs owners certified to the city as done</p>
              </div>
              <div>
                <p className="big">{(pulse.falseCert + pulse.invalidCert).toLocaleString()}</p>
                <p className="muted">certifications the city stamped FALSE or INVALID</p>
              </div>
              <div>
                <p className="big">70 days</p>
                <p className="muted">
                  until HPD closes a certified violation it hasn't reinspected. A tenant may challenge the certification
                  inside them.
                </p>
              </div>
            </div>
            <p className="fine">
              Email <a href={mailto("ASK ")}>ASK and your building's address</a> and we'll send each repair its owner
              certified, with the day its 70 days run out. Reply STILL BROKEN and your answer is kept, dated, beside the
              city's record — private to you unless the city's own record later agrees. The two counts are different
              violations, not a rate; both come from{" "}
              <a href={pulse.url} target="_blank" rel="noreferrer">
                one query on the city's own file →
              </a>
            </p>
          </div>
        </section>
      )}

      <section className="band alt">
        <div className="container">
          <p className="kicker">How it works</p>
          <div className="steps">
            <div>
              <span className="num">1</span>
              <strong>Ask</strong>
              <p>Email a company name, a New York City address, or paste the letter you got. Or type it on the web.</p>
            </div>
            <div>
              <span className="num">2</span>
              <strong>Get the receipt</strong>
              <p>
                What they filed with the state, the dates, the statute, the state's own page — with the date we
                captured it. Twenty seconds, in the same thread.
              </p>
            </div>
            <div>
              <span className="num">3</span>
              <strong>Keep it</strong>
              <p>Reply FOLLOW and we email you when the filing changes. We keep every version we read — the state overwrites its own.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="container two-col">
          <div>
            <p className="kicker">Your letter, beside their filing</p>
            <h2 className="h2">Paste the letter you were given.</h2>
            <p>
              We set what it says beside what they filed: the reason in their own words, the days between the letter
              and your last day, the deadline you were given to sign, and whether the list of job titles and ages the
              law requires for anyone over 40 came with it.
            </p>
            <p className="fine">Read once by a model, kept private, never sold, never used to train anything.</p>
          </div>
          <div>
            <p className="kicker">Buildings too</p>
            <h2 className="h2">"It's fixed," said the landlord.</h2>
            <p>
              New York City inspects and stamps that claim FALSE CERTIFICATION — in those words — then
              overwrites the record. Email us the address and you get every record for the building, dated.
            </p>
            {b && b.buildings > 0 && (
              <p className="fine">
                Right now we hold {b.records.toLocaleString()} records across {b.buildings} New York City buildings,
                kept since {b.since}. When the city changes one, we keep the version it replaced.
              </p>
            )}
            <p className="fine">Class C is immediately hazardous, B hazardous, A non-hazardous — the city's own scale.</p>
          </div>
        </div>
      </section>

      <section className="band alt">
        <div className="container">
          <Pricing />
        </div>
      </section>

      <section className="band">
        <div className="container two-col">
          <div>
            <p className="kicker">Who it's for</p>
            <p>
              People who got a letter this month. Tenant organisers keeping a building's record. The lawyers both of
              them bring it to.
            </p>
          </div>
          <div>
            <p className="kicker">What we never say</p>
            <p>
              "Illegal." Employers can claim exceptions; that is a lawyer's call. We show two dates and one statute,
              link to the government's own page, and keep the version they overwrote. We are the dated proof you bring
              them.
            </p>
          </div>
        </div>
      </section>

      <footer className="band foot-band">
        <div className="container foot-row">
          <span>Faultline · {INBOX}</span>
          <span className="muted">
            Built on Convex, AgentMail, Firecrawl and OpenAI. Reply STOP to any email to stop.{" "}
            <a href="/privacy" onClick={(e) => { e.preventDefault(); go("/privacy"); }}>Privacy</a> ·{" "}
            <a href="/terms" onClick={(e) => { e.preventDefault(); go("/terms"); }}>Terms</a>
          </span>
        </div>
      </footer>
    </>
  );
}
