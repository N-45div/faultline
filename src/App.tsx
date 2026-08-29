import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import Employer from "./Employer";
import "./styles.css";

// Every string on this page is read by a person who got a letter this month.
// No engine nouns: nothing here is a source, a diff, a snapshot or a job.

const NY_STATUTE_URL = "https://dol.ny.gov/warn-notices";

function when(ms?: number): string {
  if (!ms) return "not yet";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const toSlug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (p: string) => {
    window.history.pushState({}, "", p);
    setPath(p);
  };
  return [path, go];
}

export default function App() {
  const [path, go] = usePath();
  const employerMatch = /^\/e\/([^/]+)/.exec(path);

  return (
    <main className="page">
      <header className="masthead">
        <h1>Notice</h1>
        <p className="promise">
          Email us a company name. We send back what they told the government — and keep every version, because
          they overwrite the old ones.
        </p>
      </header>
      {employerMatch ? <Employer q={decodeURIComponent(employerMatch[1])} onBack={() => go("/")} /> : <Landing go={go} />}
    </main>
  );
}

function Landing({ go }: { go: (p: string) => void }) {
  const ny = useQuery(api.wall.layoffNotices, { slug: "ny-warn" });
  const wall = useQuery(api.wall.recent, {});
  const checked = useQuery(api.wall.lastChecked, {});
  const [q, setQ] = useState("");
  const hero = ny?.shortest[0];

  return (
    <>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) go(`/e/${toSlug(q)}`);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="A company name — or email it to us" aria-label="Company name" />
        <button type="submit">Get the receipt</button>
      </form>

      {hero && ny && (
        <section className="hero" aria-label="A filing as it stands today">
          <p className="kicker">In New York's layoff file today</p>
          <h2>
            {hero.company} filed a layoff notice for {hero.workers} workers and gave them {days(hero.actualDays)}.
          </h2>
          <p className="gap">
            <strong>
              {days(hero.actualDays)}. New York's WARN Act sets {ny.statutoryDays}.
            </strong>
          </p>
          <dl className="facts">
            <div>
              <dt>Where</dt>
              <dd>{hero.site}</dd>
            </div>
            <div>
              <dt>Notice dated</dt>
              <dd>{hero.noticeDate}</dd>
            </div>
            <div>
              <dt>Layoff started</dt>
              <dd>{hero.effectiveDate}</dd>
            </div>
            <div>
              <dt>The state put it online</dt>
              <dd>
                {hero.postedDate} — {days(hero.postingLagDays)} after the notice
              </dd>
            </div>
          </dl>
          <p className="stat">
            {ny.underStatute} of {ny.total} notices in the file today gave less than {ny.statutoryDays} days.{" "}
            {ny.postedAfterStart} were put online after the layoff had already started.
          </p>
          <p className="fine">
            Employers can claim exceptions. This is a question for a lawyer; this page is the dated proof you bring
            them.{" "}
            <a href={NY_STATUTE_URL} target="_blank" rel="noreferrer">
              Check it on the state's page →
            </a>{" "}
            ·{" "}
            <a href={`/e/${toSlug(hero.company)}`} onClick={(e) => { e.preventDefault(); go(`/e/${toSlug(hero.company)}`); }}>
              This employer's receipt →
            </a>
          </p>
        </section>
      )}

      {ny && !hero && (
        <section className="hero">
          <p className="kicker">Reading New York's layoff file…</p>
        </section>
      )}

      <section className="wall" aria-label="What changed">
        <h3>What changed</h3>
        {wall === undefined && <p className="muted">Loading…</p>}
        {wall && wall.length === 0 && (
          <p className="muted">
            Nothing has moved since we started looking. When a filing changes, it appears here with the time we saw
            it — and we keep the old version, because those pages get overwritten.
          </p>
        )}
        {wall && wall.length > 0 && (
          <ul>
            {wall.map((w, i) => (
              <li key={i}>
                <time>{when(w.at)}</time>
                <span>{w.sentence}</span>
                <a href={w.sourceUrl} target="_blank" rel="noreferrer">
                  check it →
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="foot">
        <p>
          Last read:{" "}
          {checked?.map((c, i) => (
            <span key={c.label}>
              {i > 0 && " · "}
              {c.label} {when(c.at)}
            </span>
          ))}
        </p>
        <p className="fine">The agency may correct a record after we read it. We keep every version, dated.</p>
      </footer>
    </>
  );
}
