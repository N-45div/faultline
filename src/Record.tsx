import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
 * note, and never which home: the same as the letter /try sends. A browser
 * trial's answer is labelled a practice one: anyone can give it, so it is not
 * a tenant's word.
 */
function summaryText({ asked, answers, before, read, trial }: { asked: Item; answers: Item[]; before: Earlier | undefined; read: CityPageRead | undefined; trial: boolean }): string {
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
  const said = trial ? "Answer (practice, Faultline's browser trial, never counted publicly)" : "Tenant's answer";
  if (answers.length === 0) lines.push(`${said}: none yet.`);
  for (const a of answers) if (a.answer) lines.push(`${said}: ${WORD[a.answer]}, ${day(a.saidAt ?? 0)}.`);
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

/** A repair's place on the page: /try's link and the list at the top open it by #v-<number>. */
const anchorOf = (violationId: string) => `v-${violationId}`;
const ANCHOR = /^#(v-\d{1,12})$/;

/**
 * Opening the record at one repair: the case is brought into view and lit for
 * a moment. The cases above it are still reading the city's pages as the
 * record opens, and grow as they do, so for a few seconds the case is kept in
 * view, until the person scrolls or taps themselves. With reduced motion set,
 * it jumps rather than glides, and the light does not fade.
 */
function useOpenAt(ready: boolean): (anchor: string) => void {
  const stop = useRef<() => void>(() => {});
  const openAt = useCallback((anchor: string) => {
    stop.current();
    const el = document.getElementById(anchor);
    if (!el || !el.classList.contains("case")) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const behavior: ScrollBehavior = still ? "auto" : "smooth";
    el.scrollIntoView({ block: "start", behavior });
    el.classList.remove("case-lit");
    void el.offsetWidth; // named again: the light starts over
    el.classList.add("case-lit");
    let held = true;
    const letGo = () => {
      held = false;
    };
    const grow = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => held && el.scrollIntoView({ block: "start", behavior }));
    if (el.parentElement) grow?.observe(el.parentElement);
    const hands = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const h of hands) window.addEventListener(h, letGo, { passive: true });
    const unlight = window.setTimeout(() => el.classList.remove("case-lit"), 2400);
    const done = window.setTimeout(() => end(), 3000);
    const end = () => {
      grow?.disconnect();
      for (const h of hands) window.removeEventListener(h, letGo);
      window.clearTimeout(unlight);
      window.clearTimeout(done);
      el.classList.remove("case-lit");
      stop.current = () => {};
    };
    stop.current = end;
  }, []);
  useEffect(() => {
    if (!ready) return;
    const fromHash = () => {
      const m = ANCHOR.exec(window.location.hash);
      if (m) openAt(m[1]);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      stop.current();
    };
  }, [ready, openAt]);
  return openAt;
}

/**
 * A person's own 311 call, got ready: what the call taker will ask for and
 * what they came to say, from this page's own facts, in their words where the
 * page has them. Nothing is sent from here; it is theirs to change, copy or print.
 */
function callText({ asked, last, cityStatus, cityDate, certified, trial }: { asked: Item; last: Item | undefined; cityStatus: string; cityDate: string; certified: boolean; trial: boolean }): string {
  const lines = [
    "My 311 call about a housing repair",
    "Nothing has been filed. This is for my own call to 311 (or nyc.gov/311).",
    "",
    `Building: ${asked.where}`,
    `Violation number: #${asked.violationId}`,
    `The condition, in the city's words: ${asked.description || "none on the city's file"}`,
    `The owner certified it corrected on: ${asked.certifiedBy ?? "no date on the city's file"}`,
    `The city's file when Faultline asked me, ${day(asked.askedAt)}: ${asked.askedStatus}, as of ${asked.askedStatusDate}`,
    `The city's latest status: ${cityStatus}, as of ${cityDate}`,
  ];
  if (asked.laterStatus) lines.push(`HPD stamped the certification: ${asked.laterStatus}, ${asked.laterStatusDate}`);
  const whose = trial ? "a practice answer from Faultline's browser trial" : "my answer";
  lines.push(`What I see now: ${last?.answer ? `${WORD[last.answer]} (${whose}, ${day(last.saidAt ?? 0)})` : ""}`);
  if (last?.note) lines.push(`In my words: ${last.note}`);
  // Only a STILL BROKEN answer is put in their mouth as a claim; any other answer, or none, is left for them to fill,
  // so the checklist never says what they did not.
  if (last?.answer === "still_broken") {
    lines.push(certified ? "What I will say: the certified condition is still there." : "What I will say: the condition is still there, and what it is like now.");
  } else {
    lines.push("What I want to explain or ask: [describe the condition as it is now]");
  }
  return lines.join("\n");
}

/** Print one checklist and nothing else: the print rules in styles.css show only it while the body carries printing-call. */
function printCall(text: string) {
  clearCall();
  const sheet = document.createElement("pre");
  sheet.className = "call-sheet";
  sheet.textContent = text;
  document.body.appendChild(sheet);
  document.body.classList.add("printing-call");
  window.addEventListener("afterprint", clearCall, { once: true });
  window.print();
}
function clearCall() {
  document.querySelectorAll(".call-sheet").forEach((n) => n.remove());
  document.body.classList.remove("printing-call");
}

/** The checklist, behind a disclosure in each repair's next step: edited in place, copied or printed as it stands. */
function PrepareCall({ prefill, trial }: { prefill: string; trial: boolean }) {
  // Until the person types in it, it follows the page (a new status shows); after, it is theirs.
  const [edited, setEdited] = useState<string | null>(null);
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  const box = useRef<HTMLTextAreaElement>(null);
  const text = edited ?? prefill;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      box.current?.select();
      setCopied("no");
    }
    setTimeout(() => setCopied(""), 2400);
  };
  return (
    <details className="case-call">
      <summary>
        <span className="case-purpose-tag">For your call:</span> Prepare my 311 call
      </summary>
      <p>
        <strong>Nothing has been filed. This is for your own call to 311.</strong>
        {trial && " The answer in it is a practice answer from the browser trial."}
      </p>
      <p className="fine">
        <strong>Before you call:</strong> check that this is your repair, describe what you see today, and have your address and violation number
        ready.
      </p>
      <textarea
        ref={box}
        value={text}
        onChange={(e) => setEdited(e.target.value)}
        rows={text.split("\n").length + 2}
        spellCheck={false}
        aria-label="Your 311 checklist. Change anything in it."
      />
      <p className="case-call-tools">
        <button type="button" className="cta small" onClick={() => void copy()}>
          {copied === "yes" ? "Copied" : "Copy"}
        </button>
        <button type="button" className="cta small" onClick={() => printCall(text)}>
          Print
        </button>
        {edited !== null && (
          <button type="button" className="linklike" onClick={() => setEdited(null)}>
            Start over
          </button>
        )}
        {copied === "no" && <span className="fine">Your browser would not copy it. It is selected above: copy it from there.</span>}
      </p>
    </details>
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

/**
 * What the city has recorded since we asked, in one line at the top of a
 * repair: a later HPD stamp on the certification, or a new status, with both
 * dates; or that nothing new is recorded. It says only what the city's file
 * says, and never that an answer caused it. "Latest" is always the file's
 * current status; a stamp HPD recorded before it is named as well, not in its
 * place. The city dates to the day, so a change on the day of an answer is
 * "the same date", never "after".
 */
function Changed({ asked, last }: { asked: Item; last: Item | undefined }) {
  const answeredOn = last?.saidAt !== undefined ? day(last.saidAt) : null;
  if (!asked.nowStatus) {
    return (
      <p className="case-change">
        <strong>Latest city status unavailable;</strong> showing the record from when we asked ({day(asked.askedAt)}): {asked.askedStatus}, as of{" "}
        {asked.askedStatusDate}.
      </p>
    );
  }
  if (asked.nowStatus === asked.askedStatus && !asked.laterStatus) {
    return (
      <p className="case-change">
        <strong>No new city status since we asked</strong> ({day(asked.askedAt)}): the city's file still says {asked.nowStatus}, as of{" "}
        {asked.nowStatusDate}.{answeredOn ? " Your answer stays separate from the city's record." : ""}
      </p>
    );
  }
  const changedOn = ymd(asked.laterStatus ? asked.laterStatusDate : asked.nowStatusDate);
  const when =
    answeredOn === null || !changedOn
      ? "since we asked"
      : changedOn > answeredOn
        ? "after your answer"
        : changedOn === answeredOn
          ? "on the same date as your answer"
          : "since we asked, before your answer";
  const stamp = asked.laterStatus && asked.laterStatus !== asked.nowStatus ? ` HPD also stamped the certification ${asked.laterStatus}, ${asked.laterStatusDate ?? ""}.` : "";
  return (
    <p className="case-change changed">
      <strong>The city's record changed {when}.</strong> When we asked, on {day(asked.askedAt)}: {asked.askedStatus}. Latest:{" "}
      <strong>{asked.nowStatus}</strong>, {asked.nowStatusDate}.{stamp}{" "}
      {answeredOn ? "Your dated answer and the city's records are kept below." : "The city's records are kept below."}
    </p>
  );
}

/** A date as the city's file writes it, cut to the day. */
const ymd = (s: string | null | undefined) => (s ? (/^(\d{4}-\d{2}-\d{2})/.exec(s)?.[1] ?? s) : null);

/**
 * One repair's story in date order, each line saying whose word it is: the
 * earlier citation, the owner's certification, the tenant's answers, and what
 * the city's two places show now. Only facts the case already holds, and
 * never merged: the owner's, the city's and the tenant's lines stay apart.
 */
function Sequence({ id, asked, answers, before, read, cityStatus, cityDate, trial }: { id: string; asked: Item; answers: Item[]; before: Earlier | undefined; read: CityPageRead | undefined; cityStatus: string; cityDate: string; trial: boolean }) {
  const lines: { date: string; who: string; what: string }[] = [];
  if (before) {
    const was = ymd(before.certifiedDate);
    if (was) lines.push({ date: was, who: "The owner", what: `certified the same condition corrected under an earlier number, #${before.violationId}` });
    const found = ymd(before.statusDate) ?? ymd(before.inspectionDate);
    if (found && before.status) lines.push({ date: found, who: "The city", what: `recorded ${before.status} on #${before.violationId}` });
  }
  const cert = ymd(asked.certifiedBy);
  if (cert) lines.push({ date: cert, who: "The owner", what: `certified #${id} corrected` });
  for (const a of answers) {
    if (a.answer) lines.push({ date: day(a.saidAt ?? 0), who: trial ? "Practice answer" : "You", what: `said ${WORD[a.answer]}` });
  }
  const now = ymd(cityDate);
  if (now) lines.push({ date: now, who: "The city's file", what: cityStatus });
  if (read?.outcome === "kept" && read.statusText) {
    lines.push({ date: day(read.capturedAt), who: "HPD Online", what: `showed ${read.statusText}${read.statusDate ? `, ${read.statusDate}` : ""} (read by Firecrawl)` });
  } else if (read?.outcome === "not_found") {
    lines.push({ date: day(read.capturedAt), who: "HPD Online", what: "did not list it; it lists open violations only (read by Firecrawl)" });
  }
  if (lines.length < 2) return null;
  lines.sort((x, y) => x.date.localeCompare(y.date));
  return (
    <Part kind="sequence" label="In order, with dates">
      <ol className="case-sequence">
        {lines.map((l, i) => (
          <li key={i}>
            <time>{l.date}</time> <strong>{l.who}</strong> {l.what}
          </li>
        ))}
      </ol>
      {before && (
        <p className="fine">
          An earlier citation shows this repair's history. It does not show the condition stayed broken in between.
        </p>
      )}
    </Part>
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
    <article className="case" id={anchorOf(id)} aria-label={`Violation #${id}`}>
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

      <Changed asked={asked} last={last} />

      <Sequence id={id} asked={asked} answers={answers} before={before} read={read} cityStatus={cityStatus} cityDate={cityDate} trial={trial} />

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
          <p className="case-label">Here's relevant history you can bring with you</p>
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
        <p className="fine case-purpose">
          <strong>For checking the evidence:</strong>{" "}
          <a href={cityRowsUrl([id])} target="_blank" rel="noreferrer">
            the city's own row for #{id} ↗
          </a>
          {read ? ", and HPD Online's saved page above." : "."}
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
        <PrepareCall prefill={callText({ asked, last, cityStatus, cityDate, certified: nowClaim === "owner", trial })} trial={trial} />
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

      <p className="fine case-purpose">
        <strong>For someone helping you:</strong> copy this repair's summary, or print the whole record from the top of the page.
      </p>
      <CopySummary text={summaryText({ asked, answers, before, read, trial })} />
    </article>
  );
}

export default function YourRecord({ token, go }: { token: string; go: (p: string) => void }) {
  const rec = useQuery(api.attest.record, { token });
  const replies = useQuery(api.attest.deliveries, { token });
  const checks = useQuery(api.attest.recordChecks, { token });
  const openAt = useOpenAt(Boolean(rec && rec.items.length > 0));

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
        {cases.length > 0 && (
          <nav className="record-jump" aria-label="Your repairs on this page">
            <p className="case-label">Your repairs</p>
            <ul>
              {cases.map((c) => {
                const a = anchorOf(c.asked.violationId);
                return (
                  <li key={c.key}>
                    <a
                      href={`#${a}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        if (window.location.hash !== `#${a}`) window.history.pushState(window.history.state, "", `#${a}`);
                        openAt(a);
                      }}
                    >
                      {plainThing(c.asked.description) ?? "Repair"} <span className="record-jump-id">#{c.asked.violationId}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        <p className="fine">
          Anyone with this link can open it, so share it only with someone helping you, like a tenant organizer or a lawyer. Nothing here is sent
          to HPD.
        </p>
        <p className="record-tools">
          <button
            type="button"
            className="cta small"
            onClick={() => {
              clearCall();
              window.print();
            }}
          >
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
