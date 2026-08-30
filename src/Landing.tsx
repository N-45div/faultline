import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import Pricing, { INBOX, mailto } from "./Pricing";

// The front door. Everything numeric on this page is read live from the
// filings we hold — nothing here is typed in.

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export default function Landing({ go }: { go: (p: string) => void }) {
  const ny = useQuery(api.wall.layoffNotices, { slug: "ny-warn" });
  const sample = useQuery(api.lookup.employer, { q: "spirit airlines" });
  const hero = ny?.shortest[0];

  return (
    <>
      <section className="lede">
        <h1 className="lede-title">They told you one story. They filed another.</h1>
        <p className="lede-sub">
          Email us a company name or a building address. We send back what they told the government — the dates,
          the gap against the law, and the government's own page — and we keep every version, because those files
          get overwritten.
        </p>
        <div className="lede-ctas">
          <a className="cta primary" href={mailto("Spirit Airlines")}>
            Email {INBOX}
          </a>
          <a className="cta" href="/app" onClick={(e) => { e.preventDefault(); go("/app"); }}>
            Look one up on the web →
          </a>
        </div>
        <p className="fine">Free. Nothing to install, nothing to sign up for. Reply FOLLOW to hear when a filing changes.</p>
      </section>

      {ny && hero && (
        <section className="proof" aria-label="From the file today">
          <div>
            <p className="big">{ny.underStatute}</p>
            <p className="muted">
              of {ny.total} layoff notices in New York's file today gave less than the {ny.statutoryDays} days the law
              sets
            </p>
          </div>
          <div>
            <p className="big">{ny.postedAfterStart}</p>
            <p className="muted">were put online by the state after the layoff had already started</p>
          </div>
          <div>
            <p className="big">{days(hero.actualDays)}</p>
            <p className="muted">
              the shortest notice in the file right now — {hero.company}, {hero.workers} workers
            </p>
          </div>
        </section>
      )}

      <section className="how" aria-label="How it works">
        <div>
          <strong>1. Ask</strong>
          Email a company name, a New York City address, or paste the letter you got. Or type it on the web.
        </div>
        <div>
          <strong>2. Get the receipt</strong>
          What they filed with the state, the dates, the statute, the state's own page — with the date we captured
          it. Twenty seconds, in the same thread.
        </div>
        <div>
          <strong>3. Keep it</strong>
          Reply FOLLOW and we email you when the filing changes. We keep every version — the state overwrites its own.
        </div>
      </section>

      {sample && sample.receipt.kind === "layoff" && (
        <section className="sample" aria-label="A real receipt">
          <p className="kicker">A real receipt, as it reads today</p>
          <div className="hero">
            <h2>{sample.receipt.headline}</h2>
            {sample.receipt.blocks.slice(0, 1).map((b, i) => (
              <p key={i} className="gap">
                {b.map((line, j) => (
                  <span key={j}>
                    {line}
                    {j < b.length - 1 && <br />}
                  </span>
                ))}
              </p>
            ))}
            {sample.receipt.footer.slice(0, 1).map((f, i) => (
              <p key={i} className="fine">
                {f}
              </p>
            ))}
            <p className="fine">
              <a href="/e/spirit-airlines" onClick={(e) => { e.preventDefault(); go("/e/spirit-airlines"); }}>
                See the whole receipt →
              </a>
            </p>
          </div>
        </section>
      )}

      <section className="letter" aria-label="Your letter beside their filing">
        <h3>Paste your letter</h3>
        <p>
          Forward the letter you were given and we set what it says beside what they filed: the reason in their own
          words, the days between the letter and your last day, the deadline you were given to sign, and whether the
          list of job titles and ages the law requires for anyone over 40 came with it. Read once, kept private,
          never sold.
        </p>
      </section>

      <Pricing />

      <section className="who" aria-label="Who this is for">
        <h3>Who it's for</h3>
        <p>
          People who got a letter this month. Tenant organisers keeping a building's record. The lawyers both of them
          bring it to. Employers can claim exceptions; that is a lawyer's call. We are the dated proof you bring
          them.
        </p>
      </section>
    </>
  );
}
