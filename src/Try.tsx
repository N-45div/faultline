import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { INBOX, mailto } from "./Pricing";
import { SAMPLE_ASK } from "./AskCard";

// The inbox, without the email. What is typed here goes through the handler an
// email goes through - the same keyword reader, the same agent, the same tools
// writing the reply - and the reply is a row this page holds a live query on,
// so it arrives here the moment the mutation that wrote it commits.
//
// The key to the thread is made in this browser and kept in it. The words a
// person types are kept here too, and laid beside our replies by id.

const KEY = "faultline.try.session";
const MINE = "faultline.try.mine";

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

/** Our replies are plain text, as the email is. Links in them should open. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target={p.includes(location.host) ? undefined : "_blank"} rel="noreferrer">
            {p.length > 64 ? `${p.slice(0, 61)}…` : p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function Try({ go }: { go: (p: string) => void }) {
  const [session, fresh] = useSession();
  const thread = useQuery(api.web.thread, { session });
  const say = useMutation(api.web.say);
  const [draft, setDraft] = useState("");
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

  useEffect(() => {
    if (messages.length > 0) end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, waiting]);

  // What to try next follows from what the thread last said, so a person with
  // ninety seconds is never looking at an empty box.
  const next = useMemo((): { label: string; send: string; note: string }[] => {
    if (messages.length === 0) return [{ label: SAMPLE_ASK, send: SAMPLE_ASK, note: "a real Brooklyn building, from the city's file as it reads right now" }];
    const asked = /Are they\?|Is it\?/.test(lastReply) ? /#(\d{5,10})/.exec(lastReply)?.[1] : undefined;
    if (asked) {
      const sentence = neighbourSentence(lastReply);
      return [
        { label: sentence, send: sentence, note: "your own words: GPT-6 Astra reads it, and may only pick a tool" },
        { label: `#${asked} NOT SURE`, send: `#${asked} NOT SURE`, note: "a number and a word: read with no model at all" },
      ];
    }
    if (/Which repair do you mean\?/.test(lastReply)) {
      const id = /#(\d{5,10})/.exec(lastReply)?.[1];
      return id ? [{ label: `#${id} STILL BROKEN`, send: `#${id} STILL BROKEN`, note: "it asked rather than guessed; say which" }] : [];
    }
    return [
      { label: "Spirit Airlines", send: "Spirit Airlines", note: "a company name: what it filed with the state, every version kept" },
      { label: "FIND Linden Plaza Preservation LLC", send: "FIND Linden Plaza Preservation LLC", note: "Firecrawl searches the open web and holds the first page as served" },
    ];
  }, [messages.length, lastReply]);

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
    const kept = { ...mine, [id]: words };
    setMine(kept);
    try {
      localStorage.setItem(MINE, JSON.stringify(kept));
    } catch {
      /* kept for this visit only */
    }
  }

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

  return (
    <div className="try">
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
      <p className="kicker">Try it here · no email · no sign-in</p>
      <h1 className="h2">The inbox, in your browser.</h1>
      <p className="fine wide">
        What you type goes through the handler an email goes through: the same keyword reader, the same GPT-6 Astra agent, the
        same tools writing the reply. The reply arrives below by itself, because this page holds a live Convex query on
        your thread. Nothing here is emailed, and what you say here stays on your own trial page: it is never counted
        on a public one.
      </p>

      <div className="try-thread" aria-live="polite">
        {messages.length === 0 && (
          <p className="fine try-empty">
            Start with a real building. The city's file says its owner has certified repairs there; the reply lists each
            one still inside its 70 days.
          </p>
        )}
        {messages.map((m) =>
          m.who === "call" ? (
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
                <Linked text={m.text} />
              </div>
            </div>
          ),
        )}
        {waiting && ours.length > 0 && <p className="try-read try-writing">Faultline is writing…</p>}
        <div ref={end} />
      </div>

      {next.length > 0 && (
        <div className="try-next">
          {next.map((n) => (
            <button key={n.label} className="try-chip" disabled={busy || waiting} onClick={() => void send(n.send)} title={n.note}>
              <span>{n.label}</span>
              <small>{n.note}</small>
            </button>
          ))}
        </div>
      )}

      {beenAsked && !onTheLine && (
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
          placeholder={messages.length === 0 ? "ASK and a New York City address, or a company name" : "Answer in your own words, or ask about another address"}
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
        By email it is the same, plus what needs a mailbox: following a building, the evidence pack as a PDF, the
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
