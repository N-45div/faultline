import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// "We keep every version" as a count you can check: each row we hold, when we
// first and last saw it, how many versions, its hash, and what changed. All
// of it read back from what ingest wrote — nothing here is typed in.

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function Versions({ subjectKey, q }: { subjectKey: string; q?: string }) {
  const v = useQuery(api.lookup.versions, { subjectKey, q });
  if (!v || v.rows.length === 0 || !v.since) return null;
  const totalVersions = v.rows.reduce((n, r) => n + r.versions, 0);

  return (
    <section className="versions" aria-label="Versions we hold">
      <h3>Versions we hold</h3>
      <p>
        {v.rows.length} {v.rows.length === 1 ? "row" : "rows"} in {totalVersions} {totalVersions === 1 ? "version" : "versions"}, first
        captured {day(v.since)}. The file has been read {v.reads.toLocaleString()} {v.reads === 1 ? "time" : "times"} since{" "}
        {day(v.since)}{v.lastRead ? `, most recently ${when(v.lastRead)}` : ""}. Each version is hashed at capture; the hash below is
        the current one.
      </p>
      <ul>
        {v.rows.slice(0, 12).map((r) => (
          <li key={r.identityKey}>
            <time>{day(r.firstSeen)}</time>
            <span>
              {r.label}
              <br />
              <span className="muted">
                {r.versions === 1 ? "unchanged since first capture" : `${r.versions} versions, last ${when(r.lastSeen)}`} · hash{" "}
                <code>{r.hash.slice(0, 16)}</code>
              </span>
            </span>
            <span className="muted">{r.versions === 1 ? "" : `×${r.versions}`}</span>
          </li>
        ))}
      </ul>
      {v.rows.length > 12 && <p className="fine">…and {v.rows.length - 12} more rows.</p>}
      {v.changes.length > 0 && (
        <>
          <h3>What changed</h3>
          <ul>
            {v.changes.slice(0, 8).map((c) => (
              <li key={`${c.at}-${c.sentence.slice(0, 30)}`}>
                <time>{when(c.at)}</time>
                <span>{c.sentence}</span>
                <span className="muted">{c.kind}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
