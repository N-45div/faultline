import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// Git for the files the government overwrites: a log of every read, a diff
// for every commit, and a feed of everything that was deleted. Every number
// here is a live query; nothing is typed in.

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};
const n = (x: number) => x.toLocaleString();

/** Field names the adapters use, in words. */
const FIELD: Record<string, string> = {
  effectiveDate: "layoff start",
  noticeDate: "notice date",
  employeesAffected: "workers",
  layoffOrClosure: "type",
  reason: "stated reason",
  version: "link's version parameter",
  currentstatus: "status",
  currentstatusdate: "status date",
  certifiedbydate: "owner certified by",
  action: "city's action",
  grade: "grade",
  score: "score",
  updateCodes: "state's update codes",
};

export function FilesIndex({ go }: { go: (p: string) => void }) {
  const files = useQuery(api.files.index, {});
  return (
    <>
      <p className="crumbs">
        <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }}>← Faultline</a>
      </p>
      <section className="hero">
        <p className="kicker">The files</p>
        <h2>Git for the files the government overwrites.</h2>
        <p className="fine">
          Every read of every file is a commit: the bytes are hashed, the rows are diffed against the read before, and
          each change is kept with its before and its after. The agencies replace the old version. These logs are where
          it went.
        </p>
      </section>
      <section className="wall" aria-label="Files">
        <ul className="filelist">
          {(files ?? []).map((f) => (
            <li key={f.slug}>
              <a href={`/file/${f.slug}`} onClick={(e) => { e.preventDefault(); go(`/file/${f.slug}`); }}>
                <strong>{f.publisher}</strong>
              </a>
              <span className="muted">
                {n(f.rows)} rows held · read {n(f.reads)} {f.reads === 1 ? "time" : "times"}
                {f.latest ? ` · latest ${f.latest.status === 304 ? "checked, unchanged" : "commit"} ${ago(f.latest.at)}` : ""}
              </span>
              {f.latest && <code className="hash">{f.latest.hash}</code>}
            </li>
          ))}
        </ul>
        <p className="fine">
          <a href="/deleted" onClick={(e) => { e.preventDefault(); go("/deleted"); }}>What is gone from the files →</a>
        </p>
      </section>
    </>
  );
}

export function FileLog({ slug, go }: { slug: string; go: (p: string) => void }) {
  const log = useQuery(api.files.log, { slug, limit: 60 });
  if (log === undefined) return <section className="hero"><p className="kicker">Reading the log…</p></section>;
  if (log === null) return <section className="hero"><p className="kicker">No such file</p><h2>We don't hold a file by that name.</h2></section>;
  const withChanges = log.commits.filter((c) => c.kind === "commit").length;
  return (
    <>
      <p className="crumbs">
        <a href="/files" onClick={(e) => { e.preventDefault(); go("/files"); }}>← The files</a>
      </p>
      <section className="hero">
        <p className="kicker">Commit log · {log.publisher}</p>
        <h2>
          {n(log.rows)} rows held. Read {n(log.reads)} {log.reads === 1 ? "time" : "times"}; of the last {n(log.walked)} reads, {withChanges} changed something.
        </h2>
        {log.url && (
          <p className="fine">
            The file, as the state serves it right now:{" "}
            <a href={log.url} target="_blank" rel="noreferrer">{log.url.length > 90 ? `${log.url.slice(0, 87)}…` : log.url}</a>
          </p>
        )}
      </section>
      <section className="wall" aria-label="Commits">
        <ul className="commits">
          {log.commits.map((c, i) => {
            if (c.kind === "quiet") {
              return (
                <li key={`q${i}`} className="quiet">
                  <code className="hash">{c.hash}</code>
                  <time dateTime={new Date(c.to).toISOString()}>{when(c.to)}</time>
                  <span className="muted">
                    {c.count === 1 ? "read, nothing changed" : `${n(c.count)} reads, nothing changed`}
                    {c.count > 1 ? ` (back to ${when(c.from)})` : ""}
                  </span>
                  <span className="muted">same file</span>
                </li>
              );
            }
            const to = `/commit/${c.id}`;
            return (
              <li key={c.id} className="loud">
                <code className="hash">{c.hash}</code>
                <time dateTime={new Date(c.at).toISOString()}>{when(c.at)}</time>
                <span className="muted">{`${c.status} · ${n(c.rows)} rows`}</span>
                <a href={to} onClick={(e) => { e.preventDefault(); go(to); }} className="diffstat">
                  {c.added > 0 && <span className="add">+{n(c.added)}</span>}
                  {c.changed > 0 && <span className="mod">~{n(c.changed)}</span>}
                  {c.removed > 0 && <span className="del">−{n(c.removed)}</span>}
                  {c.more && <span className="muted">+</span>}
                  <span> view diff →</span>
                </a>
              </li>
            );
          })}
        </ul>
        <p className="fine">
          A hash is SHA-256 over the bytes the state served. Two reads with the same hash are the same file; "checked,
          unchanged" is the state answering 304 to our conditional request, recorded as a read with nothing in it.
        </p>
      </section>
    </>
  );
}

function Diff({ before, after, changed }: { before?: Record<string, unknown>; after?: Record<string, unknown>; changed: string[] }) {
  const keys = changed.length > 0 ? changed : [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].slice(0, 14);
  return (
    <pre className="diff">
      {keys.map((k) => {
        const b = before?.[k];
        const a = after?.[k];
        const name = FIELD[k] ?? k;
        if (b !== undefined && a !== undefined && String(b) === String(a)) return <span key={k} className="ctx">  {name}: {String(a)}{"\n"}</span>;
        return (
          <span key={k}>
            {b !== undefined && <span className="del">- {name}: {String(b)}{"\n"}</span>}
            {a !== undefined && <span className="add">+ {name}: {String(a)}{"\n"}</span>}
          </span>
        );
      })}
    </pre>
  );
}

export function Commit({ id, go }: { id: string; go: (p: string) => void }) {
  const c = useQuery(api.files.commit, { id });
  if (c === undefined) return <section className="hero"><p className="kicker">Reading the commit…</p></section>;
  if (c === null) return <section className="hero"><p className="kicker">No such commit</p></section>;
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const ch of c.changes) counts[ch.kind]++;
  return (
    <>
      <p className="crumbs">
        <a href={`/file/${c.slug}`} onClick={(e) => { e.preventDefault(); go(`/file/${c.slug}`); }}>← {c.publisher}</a>
      </p>
      <section className="hero">
        <p className="kicker">Commit <code className="hash">{c.hash}</code> · {when(c.at)}</p>
        <h2>
          {counts.removed > 0 && `${n(counts.removed)} ${counts.removed === 1 ? "row" : "rows"} gone from the state's file. `}
          {counts.changed > 0 && `${n(counts.changed)} ${counts.changed === 1 ? "row" : "rows"} it edited in place. `}
          {counts.added > 0 && `${n(counts.added)} new.`}
          {c.changes.length === 0 && "Nothing moved in this read."}
        </h2>
        <p className="fine">
          {c.status} · {n(c.rows)} rows · SHA-256 <code className="hash">{c.fullHash}</code>
          {c.url && (
            <>
              {" "}· <a href={c.url} target="_blank" rel="noreferrer">the file today</a>
            </>
          )}
          {c.bytesHeld && (
            <>
              {" "}· <a href={`/raw/${id}`}>the file as served that day ↓</a>
            </>
          )}
        </p>
        {c.bytesHeld && (
          <p className="fine">
            The download is the exact bytes we hashed: take them anywhere and the SHA-256 will match. Bytes are held for
            14 days after a read that changed something.
          </p>
        )}
        {c.firecrawl && (
          <p className="fine">
            Firecrawl fetched this page for us, and its own change tracking called it <strong>{c.firecrawl.changeStatus}</strong>
            {c.firecrawl.previousScrapeAt ? ` against its capture of ${c.firecrawl.previousScrapeAt.replace("T", " ").slice(0, 16)} UTC` : ""}. That is
            a second reading, independent of our own diff.
          </p>
        )}
        {c.firecrawl?.shotUrl && (
          <figure className="shot">
            <img src={c.firecrawl.shotUrl} alt={`${c.publisher}'s page as Firecrawl captured it`} loading="lazy" />
            <figcaption className="fine">The page as it was served at this read, captured by Firecrawl.</figcaption>
          </figure>
        )}
      </section>
      <section className="wall" aria-label="Changes">
        <ul className="changes">
          {c.changes.map((ch) => {
            const to = ch.subjectKey && /^\d{10}$/.test(ch.subjectKey) ? `/b/${ch.subjectKey}` : null;
            return (
              <li key={ch.id} className={ch.kind}>
                <span className={`tag ${ch.kind}`}>{ch.kind === "removed" ? "gone from the state's file" : ch.kind === "changed" ? "edited in place" : "added"}</span>
                <strong>{to ? <a href={to} onClick={(e) => { e.preventDefault(); go(to); }}>{ch.label}</a> : ch.label}</strong>
                <Diff before={ch.before} after={ch.after} changed={ch.changed} />
                <span className="muted">{ch.sentence}</span>
              </li>
            );
          })}
        </ul>
        {c.more && <p className="fine">Showing the first 300 changes of this commit.</p>}
      </section>
    </>
  );
}

export function Deleted({ go }: { go: (p: string) => void }) {
  const rows = useQuery(api.files.erasures, { limit: 80 });
  return (
    <>
      <p className="crumbs">
        <a href="/files" onClick={(e) => { e.preventDefault(); go("/files"); }}>← The files</a>
      </p>
      <section className="hero">
        <p className="kicker">Gone from the government's files</p>
        <h2>Rows that left a state's file. The state's site can no longer show them. This one can.</h2>
        <p className="fine">
          Each entry says what we can prove: the row was in the file the state served on one date and not in the file
          it served on the next. Why it left — a withdrawal, a correction, a purge — is the state's to say. A row counts
          as gone only when the read was complete: a whole state file, or every row for a building we watch. New York City's housing file is read three days at a time, so it never appears here — absence from a
          partial read proves nothing. Its restaurant file is read whole for every watched building, so a closed
          restaurant's scrubbed history does.
        </p>
      </section>
      <section className="wall" aria-label="Deleted rows">
        {rows && rows.length === 0 && <p className="muted">Nothing has left a whole file since we began holding it.</p>}
        <ul className="changes">
          {(rows ?? []).map((r) => (
            <li key={r.id} className="removed">
              <time dateTime={new Date(r.at).toISOString()}>{when(r.at)}</time>
              <span className="tag removed">{r.publisher}</span>
              <strong>
                {r.label}
                {r.rows > 1 && <span className="muted"> · {r.rows} rows</span>}
              </strong>
              {r.before && <Diff before={r.before} changed={[]} />}
              <span className="muted">
                {r.sentence}{" "}
                <a href={`/commit/${r.snapshotId}`} onClick={(e) => { e.preventDefault(); go(`/commit/${r.snapshotId}`); }}>the commit →</a>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
