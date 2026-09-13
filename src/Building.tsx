import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import FollowButton from "./FollowButton";
import Versions from "./Versions";
import { mailto } from "./Pricing";
import { challengeDeadline, fixedClaim } from "../engine/hpd";

// One building's record, the same words the email uses. The city's own status
// vocabulary is quoted exactly — FALSE CERTIFICATION is their phrase, not ours.
// Beside it, the one thing the city's file cannot hold: whether a repair an
// owner certified was done, in the words of someone living with it — shown
// here only once the city's own record agrees, and never in their words.

const CITY_PAGE = "https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5";

const STAMPED = new Set(["FALSE CERTIFICATION", "INVALID CERTIFICATION"]);

type Stamp = { status: string; date: string; certifiedBy: string | null; violationId: string };

/** HPD's 70 days, for a violation the owner certified; null for anything else. */
function clock(s: Stamp): string | null {
  if (fixedClaim(s.status) !== "owner") return null;
  return challengeDeadline({ violationId: s.violationId, status: s.status, statusDate: s.date, certifiedBy: s.certifiedBy, hazardClass: "", description: "" });
}

export default function Building({ bbl, onBack }: { bbl: string; onBack: () => void }) {
  const result = useQuery(api.lookup.building, { key: bbl });
  const said = useQuery(api.attest.corroborated, { bbl });

  if (result === undefined) {
    return (
      <section className="hero">
        <p className="kicker">Reading the city's record…</p>
      </section>
    );
  }

  const { receipt: r, label, stamps } = result;
  const flagged = stamps.filter((s) => STAMPED.has(s.status));
  const today = new Date().toISOString().slice(0, 10);
  const open = stamps.filter((s) => (clock(s) ?? "") >= today);

  return (
    <>
      <p className="crumbs">
        <a href="/app" onClick={(e) => { e.preventDefault(); onBack(); }}>← Faultline</a>
      </p>

      <section className="hero" aria-label="Building record">
        <p className="kicker">Housing record</p>
        <h2>{r.headline}</h2>
        {flagged.length > 0 && (
          <p className="gap">
            <strong>
              {flagged.length} {flagged.length === 1 ? "stamp" : "stamps"} the city applied after an owner said it was fixed.
            </strong>
          </p>
        )}
        <p className="fine">
          Class C is immediately hazardous, B hazardous, A non-hazardous — the city's own scale.{" "}
          <a href={CITY_PAGE} target="_blank" rel="noreferrer">
            Check it on the city's page →
          </a>
        </p>
      </section>

      {stamps.length > 0 && (
        <section className="loop" aria-label="Is it fixed?">
          <p className="kicker">Live here?</p>
          <h3>
            {open.length === 0
              ? "When the owner says a repair is done, is it?"
              : open.length === 1
                ? "The owner says one repair here is done. Is it?"
                : `The owner says ${open.length} repairs here are done. Are they?`}
          </h3>
          <p>
            An owner's certification closes the violation after 70 days unless HPD reinspects and finds it isn't done —
            and a tenant may challenge the certification, which triggers that inspection. Email ASK and this address, and
            we'll send each repair certified here, in the city's words, with the day its 70 days run out. Reply FIXED,
            STILL BROKEN or NOT SURE, and your answer is kept, dated, beside the city's record.
          </p>
          <p className="tour-ctas">
            <a className="cta primary" href={mailto(`ASK ${label}`)}>
              Email "ASK {label}"
            </a>
          </p>
          <p className="fine">
            Your answer stays private to you. It shows on this page only if the city's own record later agrees — a
            certification stamped FALSE or INVALID after you said it was still broken — and even then without your words.
            {said && said.kept > 0 ? ` ${said.kept} ${said.kept === 1 ? "answer is" : "answers are"} kept for this building.` : ""}
          </p>
        </section>
      )}

      {said && said.rows.length > 0 && (
        <section className="wall" aria-label="Said first, then the city agreed">
          <h3>Said first, then the city agreed</h3>
          <ul>
            {said.rows.map((x) => (
              <li key={x.violationId}>
                <time>{x.saidOn}</time>
                <span>
                  <strong>Still broken</strong>, said someone who follows this building
                  {x.hazardClass ? ` · class ${x.hazardClass}` : ""}
                  {x.description && (
                    <>
                      <br />
                      <span className="muted">{x.description}</span>
                    </>
                  )}
                  <br />
                  <span className="muted">
                    HPD then stamped the owner's certification {x.laterStatus} on {x.laterStatusDate}.
                  </span>
                </span>
                <span className="muted">#{x.violationId}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <FollowButton subjectKey={bbl} label={label} />

      {stamps.length > 0 && (
        <section className="wall" aria-label="Every record we hold for this building">
          <h3>Every record we hold</h3>
          <ul>
            {stamps.map((s) => {
              const c = clock(s);
              return (
                <li key={s.violationId || `${s.date}-${s.status}-${s.hazardClass}`}>
                  <time>{s.date}</time>
                  <span>
                    <strong>{s.status}</strong>
                    {s.hazardClass ? ` · class ${s.hazardClass}` : ""}
                    {s.certifiedBy ? ` · the owner certified it corrected on ${s.certifiedBy}` : ""}
                    {c ? ` · HPD's 70 days ${c >= today ? "run to" : "ran out on"} ${c}` : ""}
                    {s.description && (
                      <>
                        <br />
                        <span className="muted">{s.description}</span>
                      </>
                    )}
                  </span>
                  <span className="muted">{STAMPED.has(s.status) ? "stamped" : s.violationId ? `#${s.violationId}` : ""}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {stamps.length === 0 && (
        <p className="muted">
          We don't hold any records for {label} yet. Email the address to the inbox and we'll pull this building's
          records from the city.
        </p>
      )}

      <Versions subjectKey={bbl} />

      <footer className="foot">
        <p className="fine">
          The city may correct a record after we read it. We keep every version we read, dated. Reply FOLLOW to any
          receipt and we'll email you when this building's records change.
        </p>
      </footer>
    </>
  );
}
