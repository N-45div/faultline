import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// The web version of the receipt. Same words the email uses.

type Said = {
  corroborated: boolean;
  statementDate: string | null;
  employerStatement: string | null;
  speakerOrOutlet: string | null;
  confidence: string;
  citations: { url: string; title: string }[];
} | null;

export default function Employer({ q, onBack }: { q: string; onBack: () => void }) {
  const result = useQuery(api.lookup.employer, { q });
  const check = useAction(api.corroborate.check);
  const [said, setSaid] = useState<Said>(null);
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);

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
      {result.filing && (
        <section className="said" aria-label="What they said in public">
          <h3>What they said in public</h3>
          {!asked && (
            <>
              <p className="muted">
                The state's file gives the reason as{" "}
                {result.filing.statedReason ? <strong>{result.filing.statedReason.toLowerCase()}</strong> : "not stated"}. We can search what{" "}
                {result.filing.employer} said publicly in the month around {result.filing.filingDate}, and show you the links.
              </p>
              <button
                type="button"
                className="cta"
                disabled={asking}
                onClick={async () => {
                  setAsking(true);
                  const r2 = await check({
                    employer: result.filing!.employer,
                    filingDate: result.filing!.filingDate,
                    statedReason: result.filing!.statedReason,
                  });
                  setSaid(r2 ?? null);
                  setAsked(true);
                  setAsking(false);
                }}
              >
                {asking ? "Searching…" : "Search what they said"}
              </button>
            </>
          )}
          {asked && said?.corroborated && (
            <>
              <p className="quote">“{said.employerStatement?.replace(/^[“"]|[”"]$/g, "")}”</p>
              <p className="muted">
                {said.speakerOrOutlet}
                {said.statementDate ? ` · ${said.statementDate}` : ""} — against a filing dated {result.filing.filingDate}
                {result.filing.statedReason ? ` giving "${result.filing.statedReason.toLowerCase()}"` : ""}.
              </p>
              <p className="fine">
                {said.citations.map((c, i) => (
                  <span key={c.url}>
                    {i > 0 && " · "}
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.title || c.url}
                    </a>
                  </span>
                ))}
              </p>
              <p className="fine">Found by searching the web just now. Read the sources yourself — that is what they are for.</p>
            </>
          )}
          {asked && !said?.corroborated && (
            <p className="muted">
              We couldn't find {result.filing.employer}'s own public words from that month. That isn't evidence of anything — it
              only means the search didn't find them.
            </p>
          )}
        </section>
      )}

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
