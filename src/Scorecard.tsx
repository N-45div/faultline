import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// Each state's own file, measured against the statute that applies to it,
// from the rows we hold. Nothing here is a verdict about an employer: it is
// arithmetic on the state's own dates, per state, side by side — the number
// nobody publishes because nobody keeps all the files.

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "—");
const when = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function Scorecard({ go }: { go: (p: string) => void }) {
  const card = useQuery(api.wall.scorecard, {});
  const log = useQuery(api.wall.changelog, {});
  return (
    <>
      <p className="crumbs">
        <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }}>← Faultline</a>
      </p>
      <section className="hero">
        <p className="kicker">Scorecard{card ? ` · as of ${when(card.asOf)}` : ""}</p>
        <h2>Eight states' layoff files, each against its own statute, from the rows we hold.</h2>
        <p className="fine">
          "Under the statute" counts notices dated fewer days before the layoff than the law that applies sets — a gap,
          never a verdict, because exceptions are a lawyer's question. Where a state publishes no notice date (New
          Jersey) or writes a start date as a list, the row is held but not counted. "Posted after the layoff began"
          is the state's own lag, and only New York publishes the day it posts.
        </p>
      </section>

      {log && (
        <section className="wall" aria-label="Changelog">
          <h3>What the governments did to their files since {log.since}</h3>
          <div className="stats">
            <div>
              <p className="big">{log.deleted.toLocaleString()}</p>
              <p className="muted">rows deleted from a file we hold whole</p>
            </div>
            <div>
              <p className="big">{log.edited.toLocaleString()}</p>
              <p className="muted">rows edited in place</p>
            </div>
            <div>
              <p className="big">{log.added.toLocaleString()}</p>
              <p className="muted">rows added</p>
            </div>
          </div>
          <p className="fine">
            <a href="/deleted" onClick={(e) => { e.preventDefault(); go("/deleted"); }}>See what was deleted →</a>
            {" · "}
            <a href="/files" onClick={(e) => { e.preventDefault(); go("/files"); }}>Every file's commit log →</a>
          </p>
        </section>
      )}

      {card && (
        <section className="wall" aria-label="States">
          <div className="tablewrap">
            <table className="score">
              <thead>
                <tr>
                  <th>State</th>
                  <th>The rule</th>
                  <th>Filings held</th>
                  <th>Under the statute</th>
                  <th>Dated the day of, or after</th>
                  <th>Reason recorded</th>
                  <th>Posted after the layoff began</th>
                  <th>Edited · deleted</th>
                </tr>
              </thead>
              <tbody>
                {card.states.map((s) => (
                  <tr key={s.slug}>
                    <td>
                      <a href={`/file/${s.slug}`} onClick={(e) => { e.preventDefault(); go(`/file/${s.slug}`); }}>{s.state}</a>
                    </td>
                    <td className="muted">
                      {s.statute}, {s.statutoryDays} days
                    </td>
                    <td>
                      {s.rows.toLocaleString()}
                      {s.countable < s.rows && <span className="muted"> ({s.countable.toLocaleString()} countable)</span>}
                    </td>
                    <td>
                      <strong>{pct(s.underStatute, s.countable)}</strong> <span className="muted">({s.underStatute})</span>
                    </td>
                    <td>
                      {pct(s.zeroOrAfter, s.countable)} <span className="muted">({s.zeroOrAfter})</span>
                    </td>
                    <td>{pct(s.withReason, s.rows)}</td>
                    <td>
                      {s.postedAfterStart === null ? (
                        <span className="muted">state publishes no posting date</span>
                      ) : (
                        <>
                          {pct(s.postedAfterStart, s.countable)}
                          {s.medianPostingLag !== null && <span className="muted"> · median {s.medianPostingLag} days late</span>}
                        </>
                      )}
                    </td>
                    <td>
                      {s.edited} · {s.deleted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine">
            Every number is a query over rows read from the state's own file, with the read's URL, time and hash on
            that file's commit log. Recomputed daily.
          </p>
        </section>
      )}
    </>
  );
}
