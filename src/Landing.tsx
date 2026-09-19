import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import Pricing, { INBOX, mailto } from "./Pricing";
import AskCard from "./AskCard";

// The front door. Everything numeric on this page is read live from the
// records we hold, and the reply beside the headline is built from the city's
// rows for one real building by the functions the email reply uses. Nothing
// here is typed in.

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export default function Landing({ go }: { go: (p: string) => void }) {
  const ny = useQuery(api.wall.layoffNotices, { slug: "ny-warn" });
  const log = useQuery(api.wall.changelog, {});
  const b = useQuery(api.wall.buildings, {});
  const pulse = useQuery(api.wall.housingPulse, {});
  const sample = useQuery(api.lookup.employer, { q: "spirit airlines" });
  const hero = ny?.shortest[0];
  const r = sample?.receipt;

  // Shown in the ASK reply's place only if the building has nothing inside its 70 days.
  const layoffCard = (
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
  );

  return (
    <>
      <section className="band hero-band">
        <div className="container hero-grid">
          <div>
            <h1 className="lede-title">Your landlord told the city it's fixed. Is it?</h1>
            <p className="lede-sub">
              Email ASK and your New York City address. We send back each repair the owner certified there, in the
              city's words, with the day HPD's 70 days run out. Answer in your own words. Your answer is kept, dated,
              beside the city's record, and if the city later stamps the owner's certification FALSE or INVALID, you
              are told, with both dates.
            </p>
            <div className="lede-ctas">
              <a className="cta primary" href={mailto("ASK ")}>
                Email ASK and your address
              </a>
              <a
                className="cta"
                href="/try"
                onClick={(e) => {
                  e.preventDefault();
                  go("/try");
                }}
              >
                Try it here, no email
              </a>
            </div>
            <p className="fine">
              Free, to {INBOX}. Nothing to install, nothing to sign up for. Your answers stay private to you.
            </p>
            <p className="fine">
              Got a layoff notice? Email <a href={mailto("Spirit Airlines")}>a company name</a> and get back what it
              filed with the state, including every version the state has since overwritten.{" "}
              <a href="/files" onClick={(e) => { e.preventDefault(); go("/files"); }}>See the commit logs →</a>
            </p>
          </div>

          <AskCard go={go} whenNone={layoffCard} />
        </div>
      </section>

      {pulse && (
        <section className="band">
          <div className="container">
            <p className="kicker">From the city's own file · New York City, the last 30 days</p>
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
              The two counts are different violations, not a rate; both come from{" "}
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
              <p>
                Email ASK and your New York City address. In seconds, in the same thread, you get each repair the owner
                certified there that is still inside its 70 days, in the city's words.
              </p>
            </div>
            <div>
              <span className="num">2</span>
              <strong>Answer in your own words</strong>
              <p>
                Reply with the number and STILL BROKEN, or just say what you see. GPT-6 Astra reads a reply in your own
                words and records it against the repair you mean, or asks which one. It never writes the reply you get.
              </p>
            </div>
            <div>
              <span className="num">3</span>
              <strong>Keep it</strong>
              <p>
                Your answer lives on a private page beside what the city's file said then and says now, with what became
                of every email we sent you. It reaches the building's public page only if the city's own record later
                agrees, and never in your words.
              </p>
            </div>
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

      <section className="band">
        <div className="container two-col">
          <div>
            <p className="kicker">Layoff notices too</p>
            <h2 className="h2">Email a company name. Paste the letter you were given.</h2>
            <p>
              Get back what the employer filed with the state: the notice date and the layoff date side by side against
              the statute that actually applies, and the state's own page. Paste your letter and it sits beside the
              filing: the reason in their own words, the days between the letter and your last day, the deadline you
              were given to sign, and whether the list of job titles and ages the law requires for anyone over 40 came
              with it.
            </p>
            <p className="fine">
              <a href={mailto("Spirit Airlines")}>Email "Spirit Airlines" →</a> Letters are read once by a model, kept
              private, never sold, never used to train anything.
            </p>
          </div>
          <div>
            <p className="kicker">The city's own stamp, kept</p>
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
              Tenants living with a repair the landlord says is done. People who got a layoff letter this month. Tenant
              organisers keeping a building's record. The lawyers all of them bring it to.
            </p>
          </div>
          <div>
            <p className="kicker">What we never say</p>
            <p>
              "Illegal." Employers can claim exceptions and landlords can contest a stamp; that is a lawyer's call. We
              show the dates, the city's and the state's own words, and the version they overwrote. We are the dated
              proof you bring them.
            </p>
          </div>
        </div>
      </section>

      <footer className="band foot-band">
        <div className="container foot-row">
          <span>Faultline · {INBOX}</span>
          <span className="muted">
            Built on Convex, AgentMail, OpenAI, Firecrawl and Photon. Reply STOP to any email to stop.{" "}
            <a href="/privacy" onClick={(e) => { e.preventDefault(); go("/privacy"); }}>Privacy</a> ·{" "}
            <a href="/terms" onClick={(e) => { e.preventDefault(); go("/terms"); }}>Terms</a>
          </span>
        </div>
      </footer>
    </>
  );
}
