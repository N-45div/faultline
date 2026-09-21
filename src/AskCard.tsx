import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { askHeadline, askLine, challengeDeadline, howToAnswer, pickAsks, SAMPLE_BBL, type Ask } from "../engine/hpd";
import { mailto } from "./Pricing";

// The reply to an ASK for one real building, as it would read right now: the
// city's rows we hold for 155 Linden Boulevard put through the same functions
// the email reply is built with. Nothing on the card is typed in.

export const SAMPLE_ASK = "ASK 155 Linden Boulevard, Brooklyn";

/**
 * HPD's 70 days, drawn. The bar is the city's own arithmetic (engine/hpd.ts,
 * challengeDeadline): the day the owner certified, and the day the violation
 * closes on the owner's word if nobody goes back to look.
 */
export function Clock({ ask, today }: { ask: Ask; today: string }) {
  const until = challengeDeadline(ask);
  return until ? <ClockUntil until={until} today={today} /> : null;
}

/** The same bar, from the last of the 70 days as a reply already states it. */
export function ClockUntil({ until, today }: { until: string; today: string }) {
  const left = Math.max(0, Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000));
  const day = Math.min(70, Math.max(0, 70 - left));
  return (
    <div className="clock70" role="img" aria-label={`Day ${day} of 70. ${left} days until the city closes this on the owner's word.`}>
      <div className="clock70-bar">
        <span className="clock70-fill" style={{ width: `${(day / 70) * 100}%` }} />
        <span className="clock70-now" style={{ left: `${(day / 70) * 100}%` }} />
      </div>
      <p className="clock70-label">
        <strong>day {day} of 70</strong> · {left} {left === 1 ? "day" : "days"} until the city closes it on the owner's word
      </p>
    </div>
  );
}

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
  // One small row, worked out when the city's file changes, not 237 rows a view.
  const b = useQuery(api.wall.sampleAsk, {});

  if (b === undefined) {
    return (
      <div className={className} aria-label="A real reply">
        <div className="mail-body">
          <p className="muted">Reading the city's record…</p>
        </div>
      </div>
    );
  }

  if (b === null) return <>{whenNone}</>;
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
          <div key={a.violationId} className="ask-with-clock">
            <p>{askLine(a, b.label)}</p>
            <Clock ask={a} today={today} />
          </div>
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
