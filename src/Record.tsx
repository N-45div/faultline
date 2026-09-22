import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import { plainThing } from "../engine/askRows";
import { citedBeforeLine, cityRowsUrl, type Earlier } from "../engine/conditionHistory";
import { fixedClaim, saysFalse, withoutUnit } from "../engine/hpd";
import CitedBefore from "./CitedBefore";
import CityPage, { type CityPageRead } from "./CityPage";

// A person's own page: every repair they were asked about, what the city's
// file said then and says now, and what they said, each dated. It opens only
// from the link in their email; nothing on it appears on any public page.
//
// Each repair is one case file, in the order a person reads it: what it is,
// what the owner told the city, whether the city cited it before, what they
// said, what the city's two places show, the one thing to do next, and when
// the city's file is read again. The owner's word, the tenant's and the city's
// are kept in boxes of their own and never merged: a different date or label
// between them is two records, not a contradiction.

const WORD: Record<"fixed" | "still_broken" | "not_sure", string> = {
  fixed: "Fixed",
  still_broken: "Still broken",
  not_sure: "Not sure",
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A moment as the record prints it: the day and the time, in UTC. */
const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** What became of a reply, from AgentMail's events, in words. */
const ARRIVED: Record<string, string> = {
  sent: "Sent, waiting for the delivery report",
  accepted: "Sent",
  shown: "Shown in your browser",
  delivered: "Accepted by your mail server",
  bounced: "Bounced",
  complained: "Marked as spam",
  rejected: "Refused by the mail service",
  texted: "Sent by text",
  queued: "Queued to send",
  unsent: "Not sent",
};

type Item = NonNullable<FunctionReturnType<typeof api.attest.record>>["items"][number];
type Checks = FunctionReturnType<typeof api.attest.recordChecks>;

/**
 * One repair as plain text, for pasting into a message to someone helping:
 * the building, the number, the city's statuses with their dates, the earlier
 * citation, the tenant's answer and its day, and the city's own row. Never the
 * note, and never which home: the same as the letter /try sends.
 */
function summaryText({ asked, answers, before, read }: { asked: Item; answers: Item[]; before: Earlier | undefined; read: CityPageRead | undefined }): string {
  const thing = plainThing(asked.description);
  const lines = [`Faultline record: violation #${asked.violationId} at ${asked.where}${asked.hazardClass ? ` (class ${asked.hazardClass})` : ""}`];
  if (thing) lines.push(`Condition: ${thing}`);
  else if (asked.description) lines.push(`The city's words: ${withoutUnit(asked.description)}`);
  lines.push(
    `The city's file when we asked (${day(asked.askedAt)}): ${asked.askedStatus} as of ${asked.askedStatusDate}` +
      (asked.certifiedBy ? `; the owner certified it corrected on ${asked.certifiedBy}` : "") +
      ".",
  );
  if (asked.nowStatus) lines.push(`The city's file now: ${asked.nowStatus} as of ${asked.nowStatusDate}.`);
  if (asked.laterStatus) lines.push(`Then HPD stamped the certification ${asked.laterStatus}, ${asked.laterStatusDate}.`);
  if (asked.deadline) lines.push(`HPD's 70 days: to ${asked.deadline}.`);
  if (before) lines.push(citedBeforeLine(before));
  if (read?.outcome === "kept" && read.statusText) {
    lines.push(`HPD Online, read by Firecrawl ${at(read.capturedAt)}: ${read.statusText}${read.statusDate ? `, ${read.statusDate}` : ""}.`);
  } else if (read?.outcome === "not_found") {
    lines.push(`HPD Online, read by Firecrawl ${at(read.capturedAt)}: not listed (it lists open violations only).`);
  }
  if (answers.length === 0) lines.push("Tenant's answer: none yet.");
  for (const a of answers) if (a.answer) lines.push(`Tenant's answer: ${WORD[a.answer]}, ${day(a.saidAt ?? 0)}.`);
  lines.push(`The city's row: ${cityRowsUrl([asked.violationId])}`);
  return lines.join("\n");
}

/** The summary, copied on a tap, and shown exactly as it is copied. */
function CopySummary({ text }: { text: string }) {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    setTimeout(() => setCopied(""), 2400);
  };
  return (
    <div className="case-copy">
      <button type="button" className="cta small" onClick={() => void copy()}>
        {copied === "yes" ? "Copied" : "Copy summary"}
      </button>
      {copied === "no" && <span className="fine"> Your browser would not copy it. Select the text below instead.</span>}
      <details>
        <summary>What is copied</summary>
        <pre className="case-summary">{text}</pre>
      </details>
    </div>
  );
}

/** The way HPD takes a tenant's word: 311, by phone or on the web. */
function Call311() {
  return (
    <>
      <a href="tel:311">call 311</a> or use{" "}
      <a href="https://www.nyc.gov/311" target="_blank" rel="noreferrer">
        nyc.gov/311
      </a>
    </>
  );
}

/** One section of a case file, labelled, in a box of its own. */
function Part({ kind, label, children }: { kind: string; label: string; children: ReactNode }) {
  return (
    <section className="case-part" data-part={kind}>
      <p className="case-label">{label}</p>
      {children}
    </section>
  );
}

function RepairCase({ asked, answers, checks, today, trial, go }: { asked: Item; answers: Item[]; checks: Checks | undefined; today: string; trial: boolean; go: (p: string) => void }) {
  const id = asked.violationId;
  // What /try reads for a repair, read here for this one: the earlier citation
  // kept by convex/history.ts, and the newest reading of HPD Online.
  const history = useQuery(api.history.forRepairs, { violationIds: [id] });
  const pages = useQuery(api.cityPage.forViolations, { violationIds: [id] });
  const checked = history?.[0];
  const before = checked?.earlier[0];
  const read = pages?.[0];
  const byCity = fixedClaim(asked.askedStatus) === "city";
  const thing = plainThing(asked.description);
  const last = answers[answers.length - 1];
  const onList = checks ? checks.onList.includes(asked.subjectKey) : false;
  const cityStatus = asked.nowStatus || asked.askedStatus;
  const cityDate = asked.nowStatusDate || asked.askedStatusDate;
  const openClock = asked.deadline !== null && asked.deadline >= today;
  // Today's step follows the city's file as it reads now, not as it read when
  // we asked: a certification the city has since closed, or found false, has
  // nothing left to challenge. The owner's box above keeps the status we asked
  // about; its 70 days count here only while that same status stands.
  const nowClaim = fixedClaim(cityStatus);
  const sinceAsked = cityStatus !== asked.askedStatus;
  const challengeBy = nowClaim === "owner" && !sinceAsked && openClock ? asked.deadline : null;

  return (
    <article className="case" aria-label={`Violation #${id}`}>
      <header className="case-head">
        <h3>{thing ?? `Repair #${id}`}</h3>
        <p>
          Violation <strong>#{id}</strong>
          {asked.hazardClass ? ` · class ${asked.hazardClass}` : ""} ·{" "}
          <a href={`/b/${asked.subjectKey}`} onClick={(e) => { e.preventDefault(); go(`/b/${asked.subjectKey}`); }}>
            {asked.where}
          </a>
        </p>
        {asked.description && <p className="case-words">The city's words: {asked.description}</p>}
      </header>

      <Part kind="owner" label={byCity ? "What the city's file said" : "What the owner told the city"}>
        <p>
          When we asked, on {day(asked.askedAt)}: <strong>{asked.askedStatus}</strong> as of {asked.askedStatusDate}.
          {asked.certifiedBy ? ` The owner certified it corrected on ${asked.certifiedBy}.` : ""}
        </p>
        {asked.nowStatus && (
          <p>
            Now: <strong>{asked.nowStatus}</strong> as of {asked.nowStatusDate}
            {asked.nowStatus === asked.askedStatus ? ", unchanged" : ""}.
          </p>
        )}
        {asked.laterStatus && (
          <p>
            Then HPD stamped the certification <strong>{asked.laterStatus}</strong>, {asked.laterStatusDate}.
          </p>
        )}
        {asked.deadline && (
          <p className="fine">
            HPD's 70 days {openClock ? "run to" : "ran out on"} {asked.deadline}. If HPD has not reinspected by then, the city can close it on the
            owner's word.
          </p>
        )}
      </Part>

      {before && (
        <div className="case-before">
          <CitedBefore before={before} violationId={id} basis />
        </div>
      )}

      <Part kind="tenant" label="Your answer · private">
        {answers.length === 0 ? (
          <p>No answer yet. Answer with #{id} and FIXED, STILL BROKEN or NOT SURE, on the page you asked from or by email.</p>
        ) : (
          answers.map((a) => (
            <p key={a.id}>
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
          ))
        )}
        <p className="fine">
          {trial
            ? "Kept, dated, on this page. A browser trial's answer is a practice answer: it is never counted on the building's page."
            : "Kept, dated, on this page. It shows on the building's page only if the city's own record later agrees, and never with your words."}{" "}
          Saving an answer does not file anything with HPD.
        </p>
      </Part>

      <Part kind="city" label="What the city shows">
        {read ? (
          <CityPage read={read} violationId={id} cityStatus={cityStatus} cityDate={cityDate} />
        ) : (
          <p>
            The city's data file: {cityStatus}, {cityDate}. HPD Online's page for this repair has not been read yet.
          </p>
        )}
        <p className="fine">
          The data file and HPD Online are the city's two places, each with its own date. A different date or label between them, or beside the
          owner's word or yours, is not a contradiction: each says what it said, when it said it.
        </p>
      </Part>

      <Part kind="next" label="What to do next">
        {last?.answer === "fixed" && <p>You said it is fixed. If that changes:</p>}
        {nowClaim === "owner" ? (
          <p className="case-action">
            If it is still there, <Call311 />, give violation <strong>#{id}</strong>, and say the certified condition is still there. HPD says
            that challenge starts an audit inspection{challengeBy ? `; make it before ${challengeBy}` : ""}.
          </p>
        ) : nowClaim === "city" ? (
          <p className="case-action">
            If it is still there, <Call311 /> and describe it. The city closed this violation
            {sinceAsked ? ` after we asked (${cityStatus} as of ${cityDate})` : ""}, so there is no certification to challenge.
          </p>
        ) : (
          <p className="case-action">
            {saysFalse(cityStatus)
              ? `The city checked the owner's certification and found it false or invalid: ${cityStatus} as of ${cityDate}.`
              : `The city's file now says ${cityStatus} as of ${cityDate}, not that the owner certified it corrected.`}{" "}
            There is no certification left to challenge. If it is still there, <Call311 /> and describe it; the violation number is{" "}
            <strong>#{id}</strong>.
          </p>
        )}
        <p className="fine">
          Then, if you like, send this record to someone helping you, like a tenant organizer or a lawyer: give them this page's link, a printed
          copy, or the summary below. If you answered on{" "}
          <a href="/try" onClick={(e) => { e.preventDefault(); go("/try"); }}>
            the browser trial
          </a>
          , its "Send this record to someone helping you" box writes to them for you.
        </p>
      </Part>

      <Part kind="checks" label="What is checked next">
        {checks ? (
          <p>
            {onList
              ? `Faultline reads the city's housing file for this building about every ${checks.everyHours} hours.`
              : "This building is not on the list the city's housing file is read for right now; what is above is as of its last read."}
            {checks.lastReadAt !== null && ` Last read ${at(checks.lastReadAt)}${checks.lastReadFailed ? ", which did not go through; it is tried again" : ""}.`}
            {onList && checks.nextReadAt !== null && ` Next read due ${checks.nextReadAt <= Date.now() ? "now" : at(checks.nextReadAt)}.`}
            {onList && " When the city changes this repair's row, its new status and date show here."}
          </p>
        ) : (
          <p className="fine">Opening when the city's file was last read…</p>
        )}
        <p className="fine">
          {history !== undefined &&
            (checked ? `Checked for an earlier citation of the same condition on ${day(checked.checkedAt)}. ` : "Not yet checked for an earlier citation of the same condition. ")}
          HPD Online's page is read when someone answers about this repair, not on a schedule{read ? `; last read ${at(read.capturedAt)}` : ""}.
        </p>
      </Part>

      <CopySummary text={summaryText({ asked, answers, before, read })} />
    </article>
  );
}

export default function YourRecord({ token, go }: { token: string; go: (p: string) => void }) {
  const rec = useQuery(api.attest.record, { token });
  const replies = useQuery(api.attest.deliveries, { token });
  const checks = useQuery(api.attest.recordChecks, { token });

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
  const cases = [...groups.entries()].map(([key, g]) => ({
    key,
    asked: g[g.length - 1],
    answers: g.filter((x) => x.answer && x.saidAt !== undefined).sort((a, b) => (a.saidAt ?? 0) - (b.saidAt ?? 0)),
  }));
  // The glance at the top: the newest answer to each repair is the one counted.
  const lastWord = cases.map((c) => c.answers[c.answers.length - 1]?.answer);
  const answered = lastWord.filter(Boolean).length;
  const broken = lastWord.filter((a) => a === "still_broken").length;
  const byOwner = cases.every((c) => fixedClaim(c.asked.askedStatus) === "owner");
  const repairs = cases.length === 1 ? "a repair was" : `${cases.length} repairs were`;

  return (
    <>
      <section className="hero record-hero" aria-label="Your record">
        <p className="kicker">Your record · since {day(rec.since)}</p>
        <h2>Your word, beside the city's.</h2>
        {cases.length > 0 && (
          <dl className="record-glance">
            <dt>What happened</dt>
            <dd>{byOwner ? `The owner told the city ${repairs} fixed, and we asked you.` : `The city's file says ${repairs} fixed or closed, and we asked you.`}</dd>
            <dt>What we know</dt>
            <dd>
              {answered === 0 ? "You have not answered yet." : `You answered ${answered} of ${cases.length}${broken > 0 ? `; ${broken} still broken` : ""}.`} Each
              is dated below, beside the city's record.
            </dd>
            <dt>What to do next</dt>
            <dd>For a repair still broken, call 311, give its violation number, and say it is still there. Saving an answer here does not file anything with HPD.</dd>
          </dl>
        )}
        <p className="fine">
          Anyone with this link can open it, so share it only with someone helping you, like a tenant organizer or a lawyer. Nothing here is sent
          to HPD.
        </p>
        <p className="record-tools">
          <button type="button" className="cta small" onClick={() => window.print()}>
            Print this record
          </button>
        </p>
      </section>

      <div className="record-cases" aria-label="Your answers">
        {cases.map((c) => (
          <RepairCase key={c.key} asked={c.asked} answers={c.answers} checks={checks} today={today} trial={rec.trial} go={go} />
        ))}
      </div>

      {replies && replies.length > 0 && (
        <section className="wall record" aria-label="Our replies to you">
          <h3>Our replies to you</h3>
          <ul>
            {replies.map((r) => (
              <li key={`${r.at}-${r.headline}`}>
                <time>{day(r.at)}</time>
                <div>
                  {r.headline}
                  <br />
                  <span className="muted">
                    {ARRIVED[r.status] ?? r.status}
                    {r.error ? `: ${r.error}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="fine">To stop email from us, reply STOP to any message we sent.</p>
    </>
  );
}
