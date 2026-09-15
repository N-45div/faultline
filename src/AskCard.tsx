import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { askHeadline, askLine, howToAnswer, pickAsks } from "../engine/hpd";
import { mailto } from "./Pricing";

// The reply to an ASK for one real building, as it would read right now: the
// city's rows we hold for 155 Linden Boulevard put through the same functions
// the email reply is built with. Nothing on the card is typed in.

export const SAMPLE_ASK = "ASK 155 Linden Boulevard, Brooklyn";
const SAMPLE_BBL = "3050840061";

export default function AskCard({
  go,
  className = "mail-card",
  whenNone = null,
}: {
  go: (p: string) => void;
  className?: string;
  /** Shown instead when no certification at the building is inside its 70 days. */
  whenNone?: ReactNode;
}) {
  const b = useQuery(api.lookup.building, { key: SAMPLE_BBL });

  if (b === undefined) {
    return (
      <div className={className} aria-label="A real reply">
        <div className="mail-body">
          <p className="muted">Reading the city's record…</p>
        </div>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const asks = pickAsks(
    b.stamps.map((s) => ({
      currentstatus: s.status,
      currentstatusdate: s.date,
      certifiedbydate: s.certifiedBy,
      violationid: s.violationId,
      class: s.hazardClass,
      novdescription: s.description,
    })),
    today,
  );
  if (asks.length === 0) return <>{whenNone}</>;

  return (
    <div className={className} aria-label="A real reply">
      <div className="mail-head">
        <span className="dot" />
        <span>
          <strong>Re: {SAMPLE_ASK}</strong> · what the reply says right now
        </span>
      </div>
      <div className="mail-body">
        <p>
          <strong>{askHeadline(asks.length)}</strong>
        </p>
        {asks.map((a) => (
          <p key={a.violationId}>{askLine(a, b.label)}</p>
        ))}
        {howToAnswer(asks[0].violationId).map((line) => (
          <p className="fine" key={line}>
            {line}
          </p>
        ))}
        <p className="fine">
          <a href={mailto(SAMPLE_ASK)}>Send it and get this reply →</a> ·{" "}
          <a href={`/b/${SAMPLE_BBL}`} onClick={(e) => { e.preventDefault(); go(`/b/${SAMPLE_BBL}`); }}>
            This building's record →
          </a>
        </p>
      </div>
    </div>
  );
}
