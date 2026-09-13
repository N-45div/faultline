import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// A person's own page: every repair they were asked about, what the city's
// file said then and says now, and what they said, each dated. It opens only
// from the link in their email; nothing on it appears on any public page.

const WORD: Record<"fixed" | "still_broken" | "not_sure", string> = {
  fixed: "Fixed",
  still_broken: "Still broken",
  not_sure: "Not sure",
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function YourRecord({ token, go }: { token: string; go: (p: string) => void }) {
  const rec = useQuery(api.attest.record, { token });

  if (rec === undefined) {
    return (
      <section className="hero">
        <p className="kicker">Opening your record…</p>
      </section>
    );
  }
  if (rec === null) {
    return (
      <section className="hero">
        <p className="kicker">Not found</p>
        <h2>This link doesn't open a record.</h2>
        <p className="fine">The link in your email is the way in. If it no longer works, reply to that email.</p>
      </section>
    );
  }

  const items = rec.items;
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const key = `${it.subjectKey}/${it.violationId}`;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }

  return (
    <>
      <section className="hero" aria-label="Your record">
        <p className="kicker">Your record · since {day(rec.since)}</p>
        <h2>Your word, beside the city's.</h2>
        <p className="fine">
          Each repair we asked you about: what the city's file said when we asked, what it says now, and what you told
          us, each with its date. Anyone with this link can open it, so share it only with someone helping you, like a
          tenant organizer or a lawyer. Nothing here is sent to HPD.
        </p>
      </section>

      <section className="wall record" aria-label="Your answers">
        <ul>
          {[...groups.entries()].map(([key, g]) => {
            const asked = g[g.length - 1];
            const answers = g.filter((x) => x.answer && x.saidAt !== undefined).sort((a, b) => (a.saidAt ?? 0) - (b.saidAt ?? 0));
            const later = g.find((x) => x.laterStatus);
            return (
              <li key={key}>
                <time>{asked.askedStatusDate}</time>
                <div>
                  <strong>#{asked.violationId}</strong> at{" "}
                  <a href={`/b/${asked.subjectKey}`} onClick={(e) => { e.preventDefault(); go(`/b/${asked.subjectKey}`); }}>
                    {asked.where}
                  </a>
                  {asked.hazardClass ? ` · class ${asked.hazardClass}` : ""}
                  {asked.description && (
                    <>
                      <br />
                      <span className="muted">{asked.description}</span>
                    </>
                  )}
                  <br />
                  The city's file when we asked: {asked.askedStatus} as of {asked.askedStatusDate}
                  {asked.certifiedBy ? `, certified ${asked.certifiedBy}` : ""}.
                  {asked.nowStatus && asked.nowStatus !== asked.askedStatus && (
                    <>
                      <br />
                      The city's file now: {asked.nowStatus} as of {asked.nowStatusDate}.
                    </>
                  )}
                  {asked.deadline && (
                    <>
                      <br />
                      HPD's 70 days {asked.deadline >= today ? "run to" : "ran out on"} {asked.deadline}.
                    </>
                  )}
                  {answers.length === 0 && (
                    <p className="said muted">
                      No answer yet. Reply to the email with #{asked.violationId} and FIXED, STILL BROKEN or NOT SURE.
                    </p>
                  )}
                  {answers.map((a) => (
                    <p className="said" key={a.id}>
                      <strong>You said: {a.answer ? WORD[a.answer] : ""}</strong>, {day(a.saidAt ?? 0)}
                      {a.note ? ` — "${a.note}"` : ""}
                      {a.photoUrl && (
                        <>
                          {" · "}
                          <a href={a.photoUrl} target="_blank" rel="noreferrer">
                            your photo
                          </a>
                        </>
                      )}
                    </p>
                  ))}
                  {later && (
                    <p className="said">
                      <strong>Then HPD stamped the certification {later.laterStatus}</strong>, {later.laterStatusDate}.
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="fine">To stop email from us, reply STOP to any message we sent.</p>
    </>
  );
}
