export const INBOX = "getnotice@agentmail.to";
export const mailto = (subject: string, body = "") =>
  `mailto:${INBOX}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ""}`;

export default function Pricing() {
  return (
    <section className="pricing" id="pricing" aria-label="Pricing">
      <h3>Pricing</h3>
      <p className="muted">Receipts are free, always. Pay when you need it on paper, or for a whole team.</p>
      <div className="tiers">
        <div className="tier">
          <p className="tier-name">Receipt</p>
          <p className="tier-price">Free</p>
          <ul>
            <li>Email a company or an address, get the filing back</li>
            <li>Paste your letter, see it beside what they filed</li>
            <li>FOLLOW one filing and hear when it changes</li>
          </ul>
          <a className="cta" href={mailto("Spirit Airlines")}>
            Email {INBOX}
          </a>
        </div>
        <div className="tier featured">
          <p className="tier-name">Evidence pack</p>
          <p className="tier-price">
            Free <span>today · $79 per pack when payments open</span>
          </p>
          <ul>
            <li>Every dated version of the filing we hold</li>
            <li>Capture times and hashes, the statute text, the intervals</li>
            <li>One PDF in your thread, usually within minutes — the thing you hand a lawyer</li>
          </ul>
          <a className="cta" href={mailto("PACK Spirit Airlines", "Replace the subject with the company name or building address the pack is for.")}>
            Email PACK + the name
          </a>
        </div>
        <div className="tier">
          <p className="tier-name">Monitor</p>
          <p className="tier-price">
            Free <span>today · $199 a month when payments open</span>
          </p>
          <ul>
            <li>Up to 500 follows for your organisation</li>
            <li>A daily digest of what changed, packs included</li>
            <li>CSV and API access are not built yet</li>
          </ul>
          <a className="cta" href={mailto("MONITOR", "Your organisation, and the employers or buildings you follow:")}>
            Email MONITOR
          </a>
        </div>
      </div>
      <p className="fine">
        Built for people who got a letter, tenant organisers, and the lawyers they bring it to. We never sell
        information about individuals, and we never say "illegal" — we show two dates and one statute.
      </p>
    </section>
  );
}
