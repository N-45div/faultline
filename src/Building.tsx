import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import FollowButton from "./FollowButton";

// One building's record, the same words the email uses. The city's own status
// vocabulary is quoted exactly — FALSE CERTIFICATION is their phrase, not ours.

const CITY_PAGE = "https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5";

const STAMPED = new Set(["FALSE CERTIFICATION", "INVALID CERTIFICATION"]);

export default function Building({ bbl, onBack }: { bbl: string; onBack: () => void }) {
  const result = useQuery(api.lookup.building, { key: bbl });

  if (result === undefined) {
    return (
      <section className="hero">
        <p className="kicker">Reading the city's record…</p>
      </section>
    );
  }

  const { receipt: r, label, stamps } = result;
  const flagged = stamps.filter((s) => STAMPED.has(s.status));

  return (
    <>
      <p className="crumbs">
        <a href="/app" onClick={(e) => { e.preventDefault(); onBack(); }}>← Notice</a>
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

      <FollowButton subjectKey={bbl} label={label} />

      {stamps.length > 0 && (
        <section className="wall" aria-label="Every record we hold for this building">
          <h3>Every record we hold</h3>
          <ul>
            {stamps.map((s) => (
              <li key={`${s.date}-${s.status}-${s.hazardClass}`}>
                <time>{s.date}</time>
                <span>
                  <strong>{s.status}</strong>
                  {s.hazardClass ? ` · class ${s.hazardClass}` : ""}
                  {s.certifiedBy ? ` · the owner had certified it corrected by ${s.certifiedBy}` : ""}
                </span>
                <span className="muted">{STAMPED.has(s.status) ? "stamped" : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stamps.length === 0 && (
        <p className="muted">
          We don't hold any records for {label} yet. Email the address to the inbox and we'll pull this building's
          records from the city.
        </p>
      )}

      <footer className="foot">
        <p className="fine">
          The city may correct a record after we read it. We keep every version, dated. Reply FOLLOW to any receipt
          and we'll email you when this building's records change.
        </p>
      </footer>
    </>
  );
}
