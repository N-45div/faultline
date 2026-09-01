import { useState } from "react";
import { Authenticated, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { INBOX } from "./Pricing";

// The tool: look something up, see what moved, see when we last read each file.

const NY_STATUTE_URL = "https://dol.ny.gov/warn-notices";

function when(ms?: number): string {
  if (!ms) return "not yet";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
export const toSlug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default function Receipts({ go }: { go: (p: string) => void }) {
  const ny = useQuery(api.wall.layoffNotices, { slug: "ny-warn" });
  const wall = useQuery(api.wall.recent, {});
  const checked = useQuery(api.wall.lastChecked, {});
  const mine = useQuery(api.follows.mine, {});
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
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="A company name, or a New York City address"
          aria-label="Company name or address"
        />
        <button type="submit">Get the receipt</button>
      </form>
      <p className="fine">
        Same thing by email: send the name to {INBOX}. Reply FOLLOW to hear when it changes.
      </p>

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
            New York put {ny.postedAfterStart} of them online after the layoff had already started.
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

      <Authenticated>
        {mine && mine.length > 0 && (
          <section className="wall" aria-label="What you follow">
            <h3>What you follow</h3>
            <ul>
              {mine.map((m) => {
                const to = m.kind === "building" ? `/b/${m.subjectKey}` : `/e/${toSlug(m.label.split(" — ")[0])}`;
                return (
                  <li key={m.subjectKey}>
                    <time>{when(m.since)}</time>
                    <span>{m.label}</span>
                    <a href={to} onClick={(e) => { e.preventDefault(); go(to); }}>
                      open →
                    </a>
                  </li>
                );
              })}
            </ul>
            <p className="fine">When any of these changes, you get one email — at most one a day.</p>
          </section>
        )}
      </Authenticated>

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
            {wall.map((w) => {
              const building = w.slug === "nyc-hpd" && w.subjectKey ? `/b/${w.subjectKey}` : null;
              return (
                <li key={`${w.slug}-${w.at}-${w.sentence.slice(0, 24)}`} className={w.weight >= 3 ? "loud" : undefined}>
                  <time>
                    {when(w.at)}
                    <span className="tag">{w.publisher}</span>
                  </time>
                  <span>
                    {w.sentence}
                    {w.count > 1 && <span className="muted"> · {w.count} records</span>}
                  </span>
                  {building ? (
                    <a href={building} onClick={(e) => { e.preventDefault(); go(building); }}>
                      the building →
                    </a>
                  ) : (
                    <a href={w.sourceUrl} target="_blank" rel="noreferrer">
                      check it →
                    </a>
                  )}
                </li>
              );
            })}
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
