import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { INBOX, mailto } from "./Pricing";
import { ClockUntil, SAMPLE_ASK } from "./AskCard";
import { canTalk, useLive } from "./useLive";
import { askRows, type AskRow } from "../engine/askRows";
import CitedBefore from "./CitedBefore";
import CityPage from "./CityPage";

// The inbox, without the email. What is typed here goes through the handler an
// email goes through - the same keyword reader, the same agent, the same tools
// writing the reply - and the reply is a row this page holds a live query on,
// so it arrives here the moment the mutation that wrote it commits.
//
// The key to the thread is made in this browser and kept in it. The words a
// person types are kept here too, and laid beside our replies by id.

const KEY = "faultline.try.session";
const MINE = "faultline.try.mine";
const GUIDE = "faultline.try.guide";
/** The thread this tab has already opened, kept for as long as the tab is. */
const OPENED = "faultline.try.opened";
/** The two certifications at the sample building that the city stamped FALSE this summer, as the city's own API serves them. */
const ROACH_ROWS = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$select=violationid,currentstatus,currentstatusdate,novdescription&$where=violationid%20in('19105968','19114310')";

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

function useSession(): [string, () => void] {
  const [session, setSession] = useState(() => {
    try {
      const held = localStorage.getItem(KEY);
      if (held && /^[a-f0-9]{32,64}$/.test(held)) return held;
      const made = hex(16);
      localStorage.setItem(KEY, made);
      return made;
    } catch {
      return hex(16);
    }
  });
  const fresh = () => {
    const made = hex(16);
    try {
      localStorage.setItem(KEY, made);
      localStorage.removeItem(MINE);
    } catch {
      /* a browser that keeps nothing still works for one visit */
    }
    setSession(made);
  };
  return [session, fresh];
}

/** How a message was heard and read, in the words the tour uses. */
function readBy(read?: string, tool?: string, cents?: number, heard?: string): string {
  const by =
    read === "agent"
      ? `read by GPT-6 Astra${tool ? ` → ${tool}` : ""}${cents !== undefined ? ` · ${cents.toFixed(2)}¢` : ""}`
      : read === "letter"
        ? "read by gpt-5.6-luna"
        : "read by the keyword reader · no model";
  return heard ? `heard by ${heard} · ${by}` : by;
}

/** Where a call stands, in words. The row behind it is a live query, so these change by themselves. */
function callStands(status?: string): string {
  switch (status) {
    case "placing":
      return "placing the call…";
    case "ringing":
      return "ringing. Pick up, and answer in your own words";
    case "on the call":
      return "on the call…";
    case "reading":
      return "the call has ended · GPT-6 Astra is reading the transcript…";
    case "completed":
      return "ended";
    case "declined":
      return "the person who answered hadn't asked for it · that number is never rung again";
    case "not answered":
      return "not answered";
    default:
      return "could not be placed";
  }
}

/** Who read a finished call, in the words the tour uses. */
function callReadBy(readBy?: string, cents?: number, unsure?: string[]): string {
  if (!readBy) return "placed by CALL-E";
  const two = readBy !== "CALL-E";
  return [
    "placed and heard by CALL-E",
    two ? `read again by GPT-6 Astra → report_call${cents !== undefined ? ` · ${cents.toFixed(2)}¢` : ""}` : "no second reader was available",
    two ? (unsure && unsure.length > 0 ? "the two readers differed, so that answer was not recorded" : "recorded only where the two agree") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What this browser records in, and the extension the transcriber knows it by. */
function recordingFormat(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  for (const [mime, ext] of [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/mp4", "mp4"],
    ["audio/ogg;codecs=opus", "ogg"],
  ] as const) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return null;
}

/** A minute is plenty for an answer, and it is what the recording is paid for by. */
const LONGEST_MS = 45_000;

/**
 * A sentence a neighbour might say about the first repair on the list, made
 * from the city's own description of it. It names the thing and says what was
 * seen, and uses none of the words the keyword reader answers to, so it is the
 * model that reads it.
 */
export function neighbourSentence(reply: string): string {
  const described = /#\d{5,10}[^"]*"([^"]+)"/.exec(reply)?.[1] ?? "";
  const d = described.toUpperCase().replace(/…/g, "").replace(/\s+/g, " ");
  const end = "(?= AT | IN | ON | AND PAINT| AND MAINTAIN|,|$)";
  const thing =
    new RegExp(`EVIDENCE OF (?:AN? )?([A-Z /-]+?)${end}`).exec(d)?.[1] ??
    new RegExp(`BROKEN OR DEFECTIVE ([A-Z /-]+?)${end}`).exec(d)?.[1] ??
    new RegExp(`ACCUMULATION OF ([A-Z /-]+?)${end}`).exec(d)?.[1] ??
    new RegExp(`NUISANCE CONSISTING OF ([A-Z /-]+?)${end}`).exec(d)?.[1] ??
    "";
  const words = thing.trim().toLowerCase().split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 5) return "Nobody has been. The first one on that list looks the same as it did before.";
  return `Nobody has been to look at the ${words.join(" ")}. It looks the same as it did before.`;
}

/**
 * What a receipt records, as a stamp on it. Read from the tool's own first
 * line ("Kept, dated: you said still broken on ..."), so the stamp can only
 * ever say what was recorded.
 */
function stampOf(reply: string): { word: string; kind: "broken" | "fixed" | "unsure" } | null {
  const said = /^Kept, dated: you said (still broken|fixed|not sure) on /.exec(reply)?.[1];
  if (!said) return null;
  return said === "still broken" ? { word: "STILL BROKEN", kind: "broken" } : said === "fixed" ? { word: "FIXED", kind: "fixed" } : { word: "NOT SURE", kind: "unsure" };
}

/** Which repair a kept answer is about, from the receipt's own line for it. */
function answeredId(reply: string): string | null {
  return stampOf(reply) ? (/^The city's file: #(\d{5,10}) at /m.exec(reply)?.[1] ?? null) : null;
}

/**
 * An ASK reply without its headline, its repair lines, which the page draws as
 * rows, and the line on typing an answer, which the rows' buttons do: what
 * becomes of an answer, and the links.
 */
function restOf(reply: string): string {
  return shown(
    reply
      .split("\n")
      .slice(1)
      .filter((l) => !l.startsWith("- #") && !l.startsWith("Reply with the number and one of FIXED"))
      .join("\n"),
  );
}

/**
 * A reply as the page shows it: without the email's closing line about
 * sending a company name, which is for the inbox, not for a tenant on this
 * page (Listen drops it too, engine/speech.ts). Only what is shown changes;
 * the stamp, the rows and a kept page are read from the reply as sent.
 */
function shown(reply: string): string {
  return reply
    .split("\n")
    .filter((l) => !/^Reply with another company name/i.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The three answers, as the button says them and as the keyword reader reads them. */
const ANSWERS = [
  ["still_broken", "Still broken", "STILL BROKEN"],
  ["fixed", "Fixed", "FIXED"],
  ["not_sure", "Not sure", "NOT SURE"],
] as const;

/**
 * A kept page's receipt, read from its own lines (agentPageKept in
 * convex/inbound.ts): the checksum, the copy we hold, the picture of it, and
 * the page as it is today. Null for any other reply, or one missing a line.
 */
function keptOf(reply: string): { shot: string | null; served: string; today: string; sha: string } | null {
  if (!/^Kept(?:: | the page at )/.test(reply)) return null;
  const link = (label: string) => new RegExp(`^${label}: (https?://\\S+)$`, "m").exec(reply)?.[1] ?? null;
  const sha = / · SHA-256 ([0-9a-f]{16})…$/m.exec(reply)?.[1];
  const served = link("The page as it was served");
  const today = link("The page today");
  if (!sha || !served || !today) return null;
  return { shot: link("The page as it looked"), served, today, sha };
}

/** A reply to FIND (the first word that it is looking, what names them, nothing, or why not), or the page it kept. */
function lookedUp(reply: string): boolean {
  return /^(?:Looking for ".*" now\.|\d+ pages? on the open web names? "|Nothing on the open web names "|We couldn't look that up: |Kept(?:: | the page at ))/.test(reply);
}

/**
 * A reply about a building, read from its headline: the building's own receipt
 * (buildingReceipt in engine/receipt.ts), the one while its records are still
 * being pulled, and an ASK with nothing to ask (convex/inbound.ts).
 */
function aboutBuilding(reply: string): boolean {
  return /^(?:.+ — (?:\d+ violations? on record\b|no housing violations in the records we hold\.$)|We don't hold .+ yet — we're pulling this building's records |No repair at .+ is certified as done right now,)/.test(
    reply.split("\n")[0],
  );
}

/**
 * A link to a person's record, where their answers sit beside the city's. Read
 * only from our own line for it (the ASK and answer receipts in
 * convex/inbound.ts), with the whole 40-character token, so a page some reply
 * merely names, like a forum's /r/..., is never taken for it.
 */
const RECORD_LINK = /^Your answers, beside the city's record: (https?:\/\/\S+\/r\/[a-f0-9]{40})\r?$/gm;
const recordIn = (reply: string): string | undefined => [...reply.matchAll(RECORD_LINK)].at(-1)?.[1];

/** Our replies are plain text, as the email is. Links in them should open. A record opens beside the thread. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target={p.includes("/r/") || !p.includes(location.host) ? "_blank" : undefined} rel="noreferrer">
            {p.length > 64 ? `${p.slice(0, 61)}…` : p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** How a letter the agent sent stands, in AgentMail's words made plain. */
const SHARE_STATUS: Record<string, string> = {
  queued: "sending…",
  sent: "sent from " + INBOX,
  delivered: "accepted by their mail server",
  bounced: "it bounced",
  complained: "they marked it as spam",
  rejected: "their server refused it",
  failed: "not sent",
  unconfirmed: "not confirmed",
};

/**
 * Send the record on: Faultline's agent writes, from its own AgentMail inbox,
 * to someone helping the tenant, with the city's record and the tenant's one
 * answer, and nothing they typed. The row below shows the letter go out and
 * their reply come back, both live.
 */
function SharePanel({ session, violationId }: { session: string; violationId: string }) {
  const send = useMutation(api.share.send);
  const shares = useQuery(api.share.forSession, { session }) ?? [];
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!to.trim() || busy) return;
    setBusy(true);
    setWhy("");
    try {
      const r = await send({ session, violationId, to });
      if (r.ok) setTo("");
      else setWhy(r.why ?? "That did not go through.");
    } catch {
      setWhy("That did not go through.");
    } finally {
      setBusy(false);
    }
  };
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";
  return (
    <div className="try-share">
      <p className="try-share-label">Send this record to someone helping you</p>
      <p className="fine">
        An organizer, a lawyer, a relative. Faultline's agent writes to them from its own inbox, {INBOX}, with the city's
        record for #{violationId} and your answer, and nothing you typed. When they reply, it lands here.
      </p>
      <form className="try-share-form" onSubmit={(e) => void submit(e)}>
        <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="their email address" aria-label="Their email address" maxLength={254} />
        <button type="submit" className="cta" disabled={busy || !to.trim()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
      {why && <p className="fine error">{why}</p>}
      {shares.map((s) => (
        <p key={s.id} className={`try-share-row ${s.status}`}>
          → {s.to} · #{s.violationId} · {SHARE_STATUS[s.status] ?? s.status}
          {(s.status === "failed" || s.status === "unconfirmed") && s.why ? ` (${s.why})` : ""} · {time(s.at)}
          {s.replies.map((r, i) => (
            <span key={i}>
              <br />
              <span className="try-share-reply">
                Their reply, {time(r.at)}: “{r.text}”
              </span>
            </span>
          ))}
          {s.stopped && " · they replied STOP, and get nothing more"}
        </p>
      ))}
    </div>
  );
}

export default function Try({ go }: { go: (p: string) => void }) {
  const [session, fresh] = useSession();
  const thread = useQuery(api.web.thread, { session });
  const say = useMutation(api.web.say);
  // /try?ask=<address>, from a housing receipt's "Check these repairs", fills the box; nothing is sent until they press.
  const [draft, setDraft] = useState(() => {
    try {
      const a = new URLSearchParams(window.location.search).get("ask");
      return a ? `ASK ${a.slice(0, 120)}` : "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const [mine, setMine] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(MINE) ?? "{}");
    } catch {
      return {};
    }
  });
  const end = useRef<HTMLDivElement>(null);
  const format = useMemo(recordingFormat, []);
  const [mic, setMic] = useState<"idle" | "recording" | "sending">("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const ended = useMutation(api.web.liveEnded);
  const talkable = useMemo(canTalk, []);
  const spoken = useRef<Set<string>>(new Set());
  const [calling, setCalling] = useState(false);
  const [phone, setPhone] = useState("");
  const [mineToRing, setMineToRing] = useState(false);

  const messages = thread ?? [];
  const ours = messages.filter((m) => m.who === "faultline");
  const waiting = messages.some((m) => m.who === "you" && !m.answered);
  const lastReply = ours.at(-1)?.text ?? "";
  // A call needs something to ask about, and one call at a time is plenty.
  const beenAsked = ours.some((m) => /Are they\?|Is it\?/.test(m.text));
  const onTheLine = messages.some((m) => m.who === "call" && ["placing", "ringing", "on the call", "reading"].includes(m.status ?? ""));

  // A thread this browser kept from an earlier visit is drawn under this page's
  // heading, which is about housing. One with no building in it - about a
  // company's layoff filings, say - would read as if it were the housing check,
  // so the person chooses first: pick it up again, or start a housing check on a
  // fresh thread. Decided once a visit, when the thread first loads: the page
  // is mounted again each time someone comes back to it from another, so the
  // thread this tab has opened, or started, is remembered while the tab is open.
  // A thread that is already about a building opens as it always has: one that
  // sent an ASK, or one we replied to about a building, however it was asked.
  const askedHousing =
    beenAsked || ours.some((m) => aboutBuilding(m.text)) || messages.some((m) => m.who === "you" && /^\s*ask\b/i.test(mine[m.id] ?? m.text));
  const openedHere = () => {
    try {
      return sessionStorage.getItem(OPENED) === session;
    } catch {
      return false;
    }
  };
  const [returning, setReturning] = useState<boolean | null>(null);
  if (returning === null && thread !== undefined) setReturning(messages.length > 0 && !askedHousing && !openedHere());
  useEffect(() => {
    if (returning !== false) return;
    try {
      sessionStorage.setItem(OPENED, session);
    } catch {
      /* a browser that keeps nothing is asked again when it comes back */
    }
  }, [returning, session]);
  // Its topic is the first thing they sent, or, when another browser typed it,
  // the headline of our first reply.
  const firstYou = messages.find((m) => m.who === "you");
  const theirFirst = firstYou ? mine[firstYou.id] || firstYou.text : "";
  const began = theirFirst || (ours[0]?.text.split("\n")[0] ?? "");
  const topic = began ? `${theirFirst ? "you began" : "our first reply"}: "${began.length > 60 ? `${began.slice(0, 57).trimEnd()}…` : began}"` : "";

  // A guide for a first visit. It is not a script: it reads what this thread has
  // actually done and says the next thing worth doing, so it can never be ahead
  // of the page or stuck behind it. Hidden for good once dismissed.
  const [guideOff, setGuideOff] = useState(() => {
    try {
      return localStorage.getItem(GUIDE) === "off";
    } catch {
      return false;
    }
  });
  const hideGuide = () => {
    setGuideOff(true);
    try {
      localStorage.setItem(GUIDE, "off");
    } catch {
      /* hidden for this visit only */
    }
  };
  const answeredOnce = ours.some((m) => stampOf(m.text) !== null);
  // The newest link to their record in anything we replied. The record page
  // holds a live query on it, so an answer given here shows there by itself.
  const rec = ours.map((m) => recordIn(m.text)).filter((u): u is string => Boolean(u)).at(-1) ?? null;
  const foundOnce = ours.some((m) => lookedUp(m.text));
  const guide: { step: 1 | 2 | 3; head: string; body: string } = answeredOnce
    ? {
        step: 3,
        head: "That is the whole loop.",
        body: "Under your message: how it was heard, who read it, which tool finished, and what it cost. The stamp is what was recorded. Next: open your record beside this page and answer another repair, ask who owns the building, or do it from your own email.",
      }
    : onTheLine
      ? { step: 2, head: "Your phone is about to ring.", body: "Pick up and answer in your own words. When you hang up, the transcript lands here and two readers go over it before anything is recorded." }
      : beenAsked
        ? {
            step: 2,
            head: "Now answer it, any way you like.",
            body: "Tap Still broken on a repair, starting with one marked Start here if the list has one (read with no model), or press the suggested sentence: GPT-6 Astra reads your own words and may only pick a tool. Or talk to it, or have it ring your phone.",
          }
        : {
            step: 1,
            head: messages.length === 0 ? "Start here: press the first button." : "Ask about a building first.",
            body:
              messages.length === 0
                ? "It asks about a real Brooklyn building. The reply is the city's own file: each repair the owner says is done, and when the city can close it on the owner's word."
                : "Type ASK and a New York City address, like ASK 155 Linden Boulevard, Brooklyn. The reply lists each repair the owner says is done.",
          };

  // The thread follows its newest message, and one picked up again opens at
  // its end. And the moment the record card first appears - drawn below the
  // guide, under the end of the thread - the page lets the stamp land, then
  // brings the card up to the bottom of the screen, with as much of the
  // stamped reply above it as fits. A thread that already had the card when
  // the page opened is not moved for it.
  const card = useRef<HTMLDivElement>(null);
  const cardSeen = useRef<boolean | null>(null);
  const cardTimer = useRef<number | undefined>(undefined);
  const hasCard = answeredOnce && rec !== null;
  // The repair the newest stamped answer was about: what a letter sent on carries.
  const lastAnswered = [...ours].reverse().map((m) => (stampOf(m.text) ? answeredId(m.text) : null)).find((id): id is string => Boolean(id)) ?? null;
  // And where the record opens: at that repair (src/Record.tsx reads the #v- anchor).
  const recAt = `${rec ?? ""}${lastAnswered ? `#v-${lastAnswered}` : ""}`;
  useEffect(() => () => window.clearTimeout(cardTimer.current), []);
  useEffect(() => {
    if (thread === undefined) return;
    const appeared = hasCard && cardSeen.current === false;
    cardSeen.current = hasCard;
    if (messages.length > 0) end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (appeared) cardTimer.current = window.setTimeout(() => card.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 900);
  }, [messages.length, waiting, hasCard, thread === undefined, returning]);

  /** Back up to the repairs, to answer the next one. */
  const toRows = () => {
    const lists = document.querySelectorAll<HTMLElement>(".try-thread .try-rows");
    lists[lists.length - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // What to try next follows from what the thread last said, so a person with
  // ninety seconds is never looking at an empty box.
  const next = useMemo((): { label: string; send: string; note: string; href?: string }[] => {
    if (messages.length === 0) return [{ label: SAMPLE_ASK, send: SAMPLE_ASK, note: "a real Brooklyn building, from the city's file as it reads right now" }];
    const asked = /Are they\?|Is it\?/.test(lastReply) ? /#(\d{5,10})/.exec(lastReply)?.[1] : undefined;
    if (asked) {
      const sentence = neighbourSentence(lastReply);
      // Drawn as rows, the reply already has a button for a number and a word.
      const drawn = askRows(lastReply).length > 0;
      return [
        { label: sentence, send: sentence, note: "your own words: GPT-6 Astra reads it, and may only pick a tool" },
        ...(drawn ? [] : [{ label: `#${asked} NOT SURE`, send: `#${asked} NOT SURE`, note: "a number and a word: read with no model at all" }]),
      ];
    }
    if (/Which repair do you mean\?/.test(lastReply)) {
      const id = /#(\d{5,10})/.exec(lastReply)?.[1];
      return id ? [{ label: `#${id} STILL BROKEN`, send: `#${id} STILL BROKEN`, note: "it asked rather than guessed; say which" }] : [];
    }
    // The owner is looked up once a thread; after that the page it kept is right there.
    return [
      ...(foundOnce ? [] : [{ label: "Who owns this building? FIND Linden Plaza Preservation LLC", send: "FIND Linden Plaza Preservation LLC", note: "Firecrawl searches the open web for the owner and holds the first page as served" }]),
      { label: "Now from your own email: ASK 155 Linden Boulevard, Brooklyn", send: "", href: mailto(SAMPLE_ASK), note: `opens your mail app, to ${INBOX} · AgentMail brings it in, and the reply lands in your inbox in seconds` },
    ];
  }, [messages.length, lastReply, foundOnce]);

  async function send(text: string, shown?: string) {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    setRefused("");
    const id = hex(6);
    keep(id, shown ?? words);
    try {
      const out = await say({ session, id, text: words });
      if (!out.ok) setRefused(out.why);
      else setDraft("");
    } catch {
      setRefused(`That did not go through. The inbox works the same way: ${INBOX}.`);
    } finally {
      setBusy(false);
    }
  }

  function keep(id: string, words: string) {
    setMine((held) => {
      const kept = { ...held, [id]: words };
      try {
        localStorage.setItem(MINE, JSON.stringify(kept));
      } catch {
        /* kept for this visit only */
      }
      return kept;
    });
  }

  // Talk to it. gpt-live-1 is the voice; what the person asks for goes through
  // the door typing goes through, and each reply a tool writes while the
  // conversation is open is handed to the voice to say, once.
  const live = useLive({ session, say, ended, keep, refuse: setRefused });
  useEffect(() => {
    for (const m of ours) {
      if (spoken.current.has(m.id)) continue;
      spoken.current.add(m.id);
      if (live.state === "on") live.speak(m.text);
    }
  }, [ours.length, live.state]);

  // Say it. The recording goes to /voice/hear, is written down by OpenAI and
  // dropped; the words come back, and go through the door typing goes through.
  async function talk() {
    if (!format || busy) return;
    if (mic === "recording") return recorder.current?.stop();
    if (mic !== "idle") return;
    setRefused("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setRefused("The microphone is blocked for this page. Allow it in the address bar, or type it.");
    }
    const parts: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: format.mime });
    recorder.current = rec;
    rec.ondataavailable = (e) => e.data.size > 0 && parts.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setMic("sending");
      const id = hex(6);
      try {
        const res = await fetch(`/voice/hear?session=${session}&id=${id}&ext=${format.ext}`, { method: "POST", headers: { "Content-Type": format.mime.split(";")[0] }, body: new Blob(parts, { type: format.mime }) });
        const out: { ok: boolean; why: string; text?: string } = await res.json();
        if (out.text) keep(id, out.text);
        if (!out.ok) setRefused(out.why);
      } catch {
        setRefused("That did not go through. Try again, or type it.");
      } finally {
        setMic("idle");
      }
    };
    rec.start();
    setMic("recording");
    setTimeout(() => rec.state === "recording" && rec.stop(), LONGEST_MS);
  }

  // Ring me. The same door again: CALL ME and the number is a message like any
  // other. This browser keeps the last four digits of it, as our tables do.
  async function ring() {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) return setRefused("Write the number with its country code, like +1 718 555 0142. US and Indian numbers can be rung.");
    if (!mineToRing) return setRefused("Tick the box first: we only ring a phone whose owner asked for the call.");
    await send(`CALL ME ${phone.trim()}`, `CALL ME · the number ending ${digits.slice(-4)}`);
    setCalling(false);
    setPhone("");
    setMineToRing(false);
  }

  // Hear it. Our reply, as the tool wrote it, read aloud as it arrives.
  function listen(replyId: string) {
    player.current?.pause();
    if (speaking === replyId) return setSpeaking(null);
    const audio = new Audio(`/voice/say?session=${session}&reply=${encodeURIComponent(replyId)}`);
    player.current = audio;
    audio.onended = () => setSpeaking(null);
    audio.onerror = () => {
      setSpeaking(null);
      setRefused("That could not be read aloud just now.");
    };
    setSpeaking(replyId);
    void audio.play().catch(() => setSpeaking(null));
  }

  // An ASK reply, drawn as the tenant's list: each repair, the city's words for
  // it, HPD's clock, and the three answers as buttons. The buttons send the line
  // a person would type, so the keyword reader takes it with no model. A kept
  // answer later in the thread puts its word on the repair it names.
  //
  // A repair the city cited before under another number says so, in the
  // city's own dates (convex/history.ts). The query reads only what was
  // already worked out, for the newest ten repairs on the page; nothing here
  // can start a read of the city's file.
  const onPage = useMemo(() => [...new Set(ours.flatMap((m) => askRows(m.text).map((r) => r.id)))].slice(-10), [ours.length]);
  const history = useQuery(api.history.forRepairs, onPage.length > 0 ? { violationIds: onPage } : "skip");
  const cited = new Map((history ?? []).map((h) => [h.violationId, h.earlier[0]] as const));
  // ---- HPD Online (src/CityPage.tsx) ----
  // The city's own page for a repair answered here, read by Firecrawl when the
  // answer was kept (convex/cityPage.ts): the newest reading of each of the
  // last five answered, one indexed read each.
  const answered = useMemo(() => [...new Set(ours.flatMap((m) => answeredId(m.text) ?? []))].slice(-5), [ours.length]);
  const cityPages = useQuery(api.cityPage.forViolations, answered.length > 0 ? { violationIds: answered } : "skip");
  const cityPage = new Map((cityPages ?? []).map((p) => [p.violationId, p] as const));
  // ---- end HPD Online ----
  const today = new Date().toISOString().slice(0, 10);
  const locked = busy || waiting || onTheLine || live.state !== "idle";
  const saidAfter = (id: string, at: number) => {
    let said: ReturnType<typeof stampOf> = null;
    for (const n of messages.slice(at + 1)) if (n.who === "faultline" && answeredId(n.text) === id) said = stampOf(n.text);
    return said;
  };
  function askList(rows: AskRow[], at: number) {
    // The repair with the most to show, the first one the city cited before under another number, is where to start:
    // its answer, HPD Online's reading, the record and the 311 checklist all carry the same number.
    const start = rows.find((r) => cited.has(r.id) && !saidAfter(r.id, at))?.id;
    return (
      <div className="try-rows">
        {rows.map((r) => {
          const said = saidAfter(r.id, at);
          const what = r.thing ? ` (${r.thing.toLowerCase()})` : "";
          const before = cited.get(r.id);
          return (
            <div key={r.id} className={`try-row${r.id === start ? " try-row-start" : ""}`} data-id={r.id}>
              {r.id === start && <p className="try-row-start-cue">Start here: this repair was cited before under a new number.</p>}
              <p className="try-row-head">
                {r.thing ? (
                  <>
                    <strong>{r.thing}</strong> · #{r.id}
                  </>
                ) : (
                  <strong>Repair #{r.id}</strong>
                )}
                {r.cls ? ` · class ${r.cls}` : ""}
                {said && (
                  <>
                    {" · "}
                    <span className={`try-row-said ${said.kind}`}>you said {said.word}</span>
                  </>
                )}
              </p>
              <p className="try-row-city">
                The city's file: {r.cityWords ? `"${r.cityWords}" · ` : ""}
                {r.status} as of {r.asOf}
              </p>
              {before && <CitedBefore before={before} violationId={r.id} />}
              {r.until && <ClockUntil until={r.until} today={today} />}
              <div className="try-row-answer">
                {ANSWERS.map(([answer, label, word]) => (
                  <button key={answer} type="button" data-answer={answer} aria-label={`${label}: #${r.id}`} aria-pressed={said?.word === word} disabled={locked} onClick={() => void send(`#${r.id} ${word}`, `${label} · #${r.id}${what}`)}>
                    {label}
                  </button>
                ))}
              </div>
              {said && <CityPage read={cityPage.get(r.id)} violationId={r.id} cityStatus={r.status} cityDate={r.asOf} />}
            </div>
          );
        })}
      </div>
    );
  }
  /** One of our replies: as rows when it is an ASK reply that reads back exactly, otherwise as the text it is. */
  function replyBody(text: string, at: number) {
    const rows = askRows(text);
    if (rows.length === 0) {
      const kept = keptOf(text);
      if (!kept?.shot) return <Linked text={shown(text)} />;
      // The headline first, then the picture; the copy we hold and the page
      // today are the reply's own lines below it, so the caption does not
      // repeat them.
      const [headline, ...rest] = text.split("\n");
      return (
        <>
          <Linked text={headline} />
          <figure className="try-evidence">
            <a href={kept.shot} target="_blank" rel="noreferrer">
              <img src={kept.shot} loading="lazy" alt="The page as Firecrawl saw it" />
            </a>
            <figcaption>Read by Firecrawl, pictured whole, kept as it was served · SHA-256 {kept.sha}…</figcaption>
          </figure>
          <Linked text={shown(rest.join("\n"))} />
        </>
      );
    }
    return (
      <>
        <strong>{text.split("\n")[0]}</strong>
        {askList(rows, at)}
        <Linked text={restOf(text)} />
      </>
    );
  }

  const head = (
    <>
      <a
        className="back"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          go("/");
        }}
      >
        ← Faultline
      </a>
      <p className="kicker">For New York City tenants · no sign-in · or email your address</p>
      <h1 className="h2">Your landlord says it's fixed. Is it?</h1>
      <p className="fine wide">
        Press the first button to ask about a real Brooklyn building. Tap <strong>Still broken</strong> on anything
        that isn't fixed: it's kept, dated, beside the city's record, and the reply tells you how to get an inspector
        sent back before its 70 days run out.
      </p>
    </>
  );

  // Back with a thread about something else: the choice, and nothing drawn from
  // that thread until it is made.
  if (returning) {
    return (
      <div className="try">
        {head}
        <div className="try-thread">
          <div className="try-empty try-resume">
            <p>This browser has a conversation from an earlier visit, and it is not a housing check.</p>
            <div className="try-next">
              <button
                type="button"
                className="try-chip"
                onClick={() => {
                  setReturning(false);
                  fresh();
                }}
              >
                <span>Start a housing check</span>
                <small>a new trial, from a real Brooklyn building · this browser will no longer open the other one</small>
              </button>
              <button type="button" className="try-chip" onClick={() => setReturning(false)}>
                <span>Resume your previous conversation</span>
                {topic && <small>{topic}</small>}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="try">
      {head}

      <div className="try-thread" aria-live="polite">
        {messages.length === 0 && (
          <p className="fine try-empty">
            A real building: 155 Linden Boulevard, Brooklyn. This summer its owner told the city the roaches in two
            compactor closets were gone, and the city stamped both certifications FALSE (
            <a href={ROACH_ROWS} target="_blank" rel="noreferrer">
              the city's own rows →
            </a>
            ). Press the first button to see what the owner has certified since.
          </p>
        )}
        {messages.map((m, at) =>
          m.who === "live" ? (
            <p key={`l${m.id}`} className="try-read try-live-done">
              🎧 A conversation with gpt-live-1 · {m.seconds ?? 0} seconds · {(m.cents ?? 0).toFixed(2)}¢ · ended by {m.status || "the page"}
            </p>
          ) : m.who === "call" ? (
            <div key={`c${m.id}`} className={`try-call-card${["completed", "declined", "not answered"].includes(m.status ?? "") ? "" : " live"}`}>
              <p className="try-call-head">
                <span aria-hidden="true">📞</span> Call to the number ending {m.tail} · {callStands(m.status)}
              </p>
              {m.turns && m.turns.length > 0 && (
                <ol className="try-turns">
                  {m.turns.map((t, i) => (
                    <li key={i} className={t.who === "you" ? "them" : "voice"}>
                      <b>{t.who === "you" ? "You" : "Call"}</b>
                      <span>{t.text}</span>
                    </li>
                  ))}
                </ol>
              )}
              {m.status !== "placing" && m.status !== "ringing" && m.status !== "on the call" && <p className="try-read">{m.status === "reading" ? "placed and heard by CALL-E · nothing is recorded until a second reader agrees" : callReadBy(m.readBy, m.cents, m.unsure)}</p>}
            </div>
          ) : m.who === "you" ? (
            <div key={`y${m.id}`} className="try-you">
              <p className="try-words">{mine[m.id] ?? "(what you wrote, from another browser)"}</p>
              <p className="try-read">{m.answered ? readBy(m.read, m.tool, m.cents, m.heard) : m.read === "agent" ? "GPT-6 Astra is reading it…" : "reading…"}</p>
            </div>
          ) : (
            <div key={`f${m.id}`} className="mail-card try-ours">
              <div className="mail-head">
                <span className="dot" />
                <span>
                  <strong>Faultline</strong> · {new Date(m.at).toISOString().slice(11, 19)} UTC
                </span>
                <button type="button" className={`try-listen${speaking === m.id ? " on" : ""}`} onClick={() => listen(m.id)} aria-pressed={speaking === m.id}>
                  {speaking === m.id ? "■ Stop" : "▶ Listen"}
                </button>
              </div>
              <div className="mail-body try-text">
                {stampOf(m.text) && (
                  <span className={`try-stamp ${stampOf(m.text)!.kind}`} aria-hidden="true">
                    {stampOf(m.text)!.word}
                    <small>kept · dated</small>
                  </span>
                )}
                {replyBody(m.text, at)}
              </div>
            </div>
          ),
        )}
        {waiting && <p className="try-read try-writing">Faultline is writing…</p>}
        <div ref={end} />
      </div>

      {!guideOff && live.state === "idle" && (
        <div className="try-guide" role="note">
          <span className="try-guide-step">Step {guide.step} of 3</span>
          <div>
            <p className="try-guide-head">{guide.head}</p>
            <p className="try-guide-body">{guide.body}</p>
          </div>
          <button type="button" className="linklike" onClick={hideGuide}>
            {guide.step === 3 ? "Got it" : "Hide the guide"}
          </button>
        </div>
      )}

      {hasCard && (
        <div className="try-record" ref={card}>
          <p>
            <strong>Your record is live:</strong> your dated answer, the city's evidence, and a checklist for your next 311
            call. Open it<span className="try-beside"> beside this page</span>, then{" "}
            <button type="button" className="linklike" onClick={toRows}>
              answer another repair ↑
            </button>{" "}
            here: it changes by itself, no reload.
          </p>
          <a
            className="cta"
            href={recAt}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              const w = window.open(recAt, "faultline-record", "popup,width=760,height=960");
              if (w) e.preventDefault();
            }}
          >
            Open your record<span className="try-beside"> beside this</span> →
          </a>
        </div>
      )}
      {hasCard && lastAnswered && <SharePanel session={session} violationId={lastAnswered} />}

      {next.length > 0 && (
        <div className="try-next">
          {next.map((n, i) =>
            n.href ? (
              <a key={n.label} className="try-chip" href={n.href} title={n.note}>
                <span>{n.label}</span>
                <small>{n.note}</small>
              </a>
            ) : (
              <button key={n.label} className={`try-chip${!guideOff && i === 0 && (guide.step === 1 || (guide.step === 2 && !onTheLine)) ? " guide-pulse" : ""}`} disabled={busy || waiting} onClick={() => void send(n.send)} title={n.note}>
                <span>{n.label}</span>
                <small>{n.note}</small>
              </button>
            ),
          )}
        </div>
      )}

      {talkable && live.state !== "idle" && (
        <div className={`try-live ${live.state}`} aria-live="off">
          <p className="try-live-head">
            <span className="try-live-dot" aria-hidden="true" />
            {live.state === "connecting" ? "Connecting to gpt-live-1…" : live.state === "ending" ? "Ending the conversation…" : `Live · ${Math.floor(live.seconds / 60)}:${String(live.seconds % 60).padStart(2, "0")} of ${Math.floor(live.limit / 60)}:${String(live.limit % 60).padStart(2, "0")}`}
            <button type="button" className="try-listen on" onClick={live.stop} disabled={live.state !== "on"}>
              ■ End
            </button>
          </p>
          {live.heard && (
            <p className="try-live-cap">
              <b>You</b>
              <span>{live.heard}</span>
            </p>
          )}
          {live.voice && (
            <p className="try-live-cap voice">
              <b>Voice</b>
              <span>{live.voice}</span>
            </p>
          )}
          <p className="fine">
            gpt-live-1 is the voice. When you ask for something it hands your words to the same door as typing: the keyword
            reader, GPT-6 Astra and the tools decide, and write the reply you see above. The voice is told to add nothing, but
            it may rephrase. The written reply is the record; the voice is not. It ends by itself at {Math.floor(live.limit / 60)}:
            {String(live.limit % 60).padStart(2, "0")}.
          </p>
        </div>
      )}

      {talkable && live.state === "idle" && !calling && (
        <div className="try-call">
          <button type="button" className="try-chip" onClick={() => void live.start()} disabled={busy || mic !== "idle"}>
            <span>🎧 Or talk to it: a live conversation</span>
            <small>gpt-live-1 is the voice · GPT-6 Astra and the tools still decide, and write every reply</small>
          </button>
        </div>
      )}

      {beenAsked && !onTheLine && live.state === "idle" && (
        <div className="try-call">
          {!calling ? (
            <button type="button" className="try-chip" onClick={() => setCalling(true)} disabled={busy || waiting}>
              <span>📞 Or have it ring you, and answer out loud</span>
              <small>a real phone call, placed by CALL-E · GPT-6 Astra reads the transcript before anything is recorded</small>
            </button>
          ) : (
            <form
              className="try-call-form"
              onSubmit={(e) => {
                e.preventDefault();
                void ring();
              }}
            >
              <label htmlFor="try-phone">Your phone number, with its country code (US or India)</label>
              <div className="try-call-row">
                <input id="try-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={24} placeholder="+1 718 555 0142" />
                <button className="cta primary" type="submit" disabled={busy}>
                  Call me
                </button>
                <button type="button" className="linklike" onClick={() => setCalling(false)}>
                  Cancel
                </button>
              </div>
              <label className="try-consent">
                <input type="checkbox" checked={mineToRing} onChange={(e) => setMineToRing(e.target.checked)} />
                <span>This is my own phone, and I am asking for one automated call to it, now.</span>
              </label>
              <p className="fine">
                The call says at once that it is automated and that you asked for it, then asks about the repairs above, one at
                a time. When you hang up, two readers go over it separately, CALL-E and GPT-6 Astra, and an answer is recorded
                only where they agree. Your number goes to CALL-E to place the call; our own tables keep a hash of it and its
                last four digits. One number is rung at most twice a day.
              </p>
              <p className="fine">
                Can't take a call right now?{" "}
                <a href="https://youtu.be/Xa8uKOZP-Y4?t=84" target="_blank" rel="noreferrer">
                  Hear the first real one, recorded on 20 September →
                </a>
              </p>
            </form>
          )}
        </div>
      )}

      <form
        className="try-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={600}
          placeholder={messages.length === 0 ? "ASK and a New York City address, like ASK 155 Linden Boulevard, Brooklyn" : "Answer in your own words, or ask about another address"}
          aria-label="Your message"
        />
        {format && (
          <button
            type="button"
            className={`try-mic ${mic}`}
            onClick={() => void talk()}
            disabled={busy || mic === "sending"}
            aria-label={mic === "recording" ? "Stop and send what you said" : "Say it instead of typing"}
            title={mic === "recording" ? "Stop and send" : "Say it instead"}
          >
            {mic === "recording" ? "■ Stop" : mic === "sending" ? "Hearing…" : "🎙 Say it"}
          </button>
        )}
        <button className="cta primary" type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
      {format && (
        <p className="fine">
          Or say it: press <strong>Say it</strong>, answer out loud the way you'd tell a neighbour, and press again. OpenAI
          writes your words down and the recording is dropped; the words go through the same door as typing. Every reply
          has a <strong>Listen</strong> button, and what it reads is what the tool wrote.
        </p>
      )}
      {refused && <p className="fine error">{refused}</p>}

      <p className="fine wide">
        What you type here goes through exactly what an email to {INBOX} goes through, and the reply arrives by
        itself from a live Convex query; it isn't emailed, and it stays on your own trial page. By email it is the
        same, plus what needs a mailbox: following a building, the evidence pack as a PDF, the
        filings as a spreadsheet, and a photo of the repair. <a href={mailto(SAMPLE_ASK)}>Email {INBOX} →</a>{" "}
        {messages.length > 0 && (
          <button className="linklike" onClick={fresh}>
            Start a new trial
          </button>
        )}
      </p>
    </div>
  );
}
