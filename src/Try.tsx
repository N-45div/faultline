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

/** How a message was read, in the words the tour uses. */
function readBy(read?: string, tool?: string, cents?: number): string {
  if (read === "agent") return `read by GPT-6 Astra${tool ? ` → ${tool}` : ""}${cents !== undefined ? ` · ${cents.toFixed(2)}¢` : ""}`;
  if (read === "letter") return "read by gpt-5.6-luna";
  return "read by the keyword reader · no model";
}

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

  const messages = thread ?? [];
  const ours = messages.filter((m) => m.who === "faultline");
  const waiting = messages.some((m) => m.who === "you" && !m.answered);
  const lastReply = ours.at(-1)?.text ?? "";

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

  async function send(text: string) {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    setRefused("");
    const id = hex(6);
    const kept = { ...mine, [id]: words };
    setMine(kept);
    try {
      localStorage.setItem(MINE, JSON.stringify(kept));
    } catch {
      /* kept for this visit only */
    }
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
          m.who === "you" ? (
            <div key={`y${m.id}`} className="try-you">
              <p className="try-words">{mine[m.id] ?? "(what you wrote, from another browser)"}</p>
              <p className="try-read">{m.answered ? readBy(m.read, m.tool, m.cents) : m.read === "agent" ? "GPT-6 Astra is reading it…" : "reading…"}</p>
            </div>
          ) : (
            <div key={`f${m.id}`} className="mail-card try-ours">
              <div className="mail-head">
                <span className="dot" />
                <span>
                  <strong>Faultline</strong> · {new Date(m.at).toISOString().slice(11, 19)} UTC
                </span>
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
        <button className="cta primary" type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
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
