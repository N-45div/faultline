import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// The web version of the receipt. Same words the email uses.

export default function Employer({ q, onBack }: { q: string; onBack: () => void }) {
  const result = useQuery(api.lookup.employer, { q });

  if (result === undefined) {
    return (
      <section className="hero">
        <p className="kicker">Looking up {q.replace(/-/g, " ")}…</p>
      </section>
    );
  }
  const r = result.receipt;

  return (
    <>
      <p className="crumbs">
        <a href="/" onClick={(e) => { e.preventDefault(); onBack(); }}>← Notice</a>
      </p>
      <section className="hero" aria-label="Receipt">
        <p className="kicker">{r.kind === "layoff" ? "Layoff filing" : r.kind === "building" ? "Housing record" : "No match"}</p>
        <h2>{r.headline}</h2>
        {r.blocks.map((b, i) => (
          <p key={i} className={i === 0 && r.kind === "layoff" ? "gap" : undefined}>
            {b.map((line, j) => (
              <span key={j}>
                {line}
                {j < b.length - 1 && <br />}
              </span>
            ))}
          </p>
        ))}
        {r.links.length > 0 && (
          <p>
            {r.links.map((l, i) => (
              <span key={l.url}>
                {i > 0 && " · "}
                <a href={l.url} target="_blank" rel="noreferrer">
                  {l.label} →
                </a>
              </span>
            ))}
          </p>
        )}
        {r.footer.map((f, i) => (
          <p key={i} className="fine">
            {f}
          </p>
        ))}
      </section>
      {r.kind === "none" && result.matches.length > 0 && (
        <p className="muted">
          Close matches:{" "}
          {result.matches.map((m, i) => (
            <span key={m.company}>
              {i > 0 && " · "}
              <a href={`/e/${m.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{m.company}</a>
            </span>
          ))}
        </p>
      )}
      <p className="fine">
        Same receipt by email: send the name to the address and reply FOLLOW to hear when it changes.
      </p>
    </>
  );
}
