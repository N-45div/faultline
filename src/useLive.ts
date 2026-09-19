import { useCallback, useEffect, useRef, useState } from "react";
import { forSpeech } from "../engine/speech";
import { utterance, type Fragment } from "../engine/live";

// A conversation with gpt-live-1, held by this page.
//
// The audio goes between the browser and OpenAI over WebRTC; our server only
// makes the session (POST /voice/live), with our key and our instructions, and
// ends it if the page does not. gpt-live-1 is built to hand anything that needs
// thought to a backend. When it asks for help the event carries no words, so
// the words are taken from the transcript fragments since the last request, and
// sent through the door typing uses (web.say). The reply is a row in the thread
// this page already holds a live query on; when it arrives it is handed back to
// the voice to say. The voice may rephrase it. The thread does not.

export type LiveState = "idle" | "connecting" | "on" | "ending";

type Say = (a: { session: string; id: string; text: string; live?: boolean }) => Promise<{ ok: boolean; why: string }>;
type Ended = (a: { session: string; liveId: string; seconds?: number }) => Promise<null>;

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const canTalk = (): boolean => typeof RTCPeerConnection !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

export function useLive(o: { session: string; say: Say; ended: Ended; keep: (id: string, words: string) => void; refuse: (why: string) => void }) {
  const [state, setState] = useState<LiveState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [limit, setLimit] = useState(150);
  const [heard, setHeard] = useState("");
  const [voice, setVoice] = useState("");

  const peer = useRef<RTCPeerConnection | null>(null);
  const events = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const fragments = useRef<Fragment[]>([]);
  const consumedMs = useRef(0);
  const waiting = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }[]>([]);
  const liveId = useRef("");
  const used = useRef(0);
  const began = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opts = useRef(o);
  opts.current = o;

  const send = (event: Record<string, unknown>) => {
    if (events.current?.readyState === "open") events.current.send(JSON.stringify({ event_id: `fl_${hex(4)}`, ...event }));
  };

  /** Hand the voice something to say, for the request it made (or for none). */
  const tell = useCallback((content: string, delegationId: string | null) => {
    const i = delegationId ? waiting.current.findIndex((w) => w.id === delegationId) : -1;
    if (i >= 0) clearTimeout(waiting.current.splice(i, 1)[0].timer);
    send({ type: "session.commentary.append", delegation_id: delegationId, content: content.slice(0, 1_800) });
    setVoice("");
  }, []);

  const cleanup = useCallback(() => {
    if (tick.current) clearInterval(tick.current);
    if (closing.current) clearTimeout(closing.current);
    for (const w of waiting.current) clearTimeout(w.timer);
    waiting.current = [];
    mic.current?.getTracks().forEach((t) => t.stop());
    try {
      events.current?.close();
      peer.current?.close();
    } catch {
      /* already closed */
    }
    if (audio.current) audio.current.srcObject = null;
    peer.current = null;
    events.current = null;
    mic.current = null;
    const id = liveId.current;
    liveId.current = "";
    if (id) void opts.current.ended({ session: opts.current.session, liveId: id, ...(used.current > 0 ? { seconds: used.current } : {}) }).catch(() => null);
    setState("idle");
    setHeard("");
    setVoice("");
  }, []);

  const stop = useCallback(() => {
    if (!peer.current) return;
    setState("ending");
    // Ask for the end, and wait for it: the last event carries the seconds that were billed.
    send({ type: "session.close" });
    closing.current = setTimeout(cleanup, 6_000);
  }, [cleanup]);

  /** The voice asked for help. The event has no words in it; the transcript does. */
  const delegated = useCallback(
    async (id: string) => {
      const timer = setTimeout(() => tell("That took too long. Please say it again, or type it on the page.", id), 40_000);
      waiting.current.push({ id, timer });
      await wait(700);
      let u = utterance(fragments.current, consumedMs.current);
      for (let i = 0; i < 5 && u.text.length < 2; i++) {
        await wait(500);
        u = utterance(fragments.current, consumedMs.current);
      }
      if (u.text.length < 2) return tell("I did not catch that. Please say it again.", id);
      consumedMs.current = u.untilMs;
      setHeard("");
      const msg = hex(6);
      opts.current.keep(msg, u.text);
      try {
        const out = await opts.current.say({ session: opts.current.session, id: msg, text: u.text, live: true });
        if (!out.ok) tell(out.why, id);
      } catch {
        tell("That did not go through. Please say it again.", id);
      }
    },
    [tell],
  );

  /** A reply a tool wrote has arrived in the thread. It answers the oldest request still waiting. */
  const speak = useCallback(
    (replyText: string) => {
      if (!peer.current) return;
      tell(forSpeech(replyText), waiting.current[0]?.id ?? null);
    },
    [tell],
  );

  const start = useCallback(async () => {
    if (peer.current) return;
    setState("connecting");
    fragments.current = [];
    consumedMs.current = 0;
    used.current = 0;
    try {
      const connection = new RTCPeerConnection();
      peer.current = connection;
      connection.addEventListener("track", (e) => {
        if (!audio.current) {
          audio.current = new Audio();
          audio.current.autoplay = true;
        }
        audio.current.srcObject = new MediaStream([e.track]);
        void audio.current.play().catch(() => opts.current.refuse("Your browser blocked the sound. Press Talk to it again."));
      });
      mic.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of mic.current.getAudioTracks()) connection.addTrack(track, mic.current);

      let greeting = "";
      const channel = connection.createDataChannel("oai-events");
      events.current = channel;
      channel.addEventListener("message", ({ data }) => {
        let event: any;
        try {
          event = JSON.parse(String(data));
        } catch {
          return;
        }
        switch (event?.type) {
          case "session.started":
            began.current = Date.now();
            setState("on");
            if (greeting) send({ type: "session.instructions.append", delegation_id: null, content: greeting });
            tick.current = setInterval(() => setSeconds(Math.floor((Date.now() - began.current) / 1000)), 500);
            break;
          case "session.input_transcript.delta":
            fragments.current.push({ delta: String(event.delta ?? ""), start_ms: Number(event.start_ms ?? 0), end_ms: Number(event.end_ms ?? 0) });
            setHeard(utterance(fragments.current, consumedMs.current).text);
            break;
          case "session.output_transcript.delta":
            setVoice((v) => (v + String(event.delta ?? "")).slice(-400));
            break;
          case "session.delegation.created":
            if (event?.delegation?.id) void delegated(String(event.delegation.id));
            break;
          case "session.usage.updated":
            used.current = Number(event?.usage?.seconds ?? used.current);
            break;
          case "session.closed":
            used.current = Number(event?.usage?.seconds ?? used.current);
            cleanup();
            break;
        }
      });
      channel.addEventListener("close", () => peer.current === connection && cleanup());

      await connection.setLocalDescription(await connection.createOffer());
      if (connection.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 8_000);
          connection.addEventListener("icegatheringstatechange", () => {
            if (connection.iceGatheringState !== "complete") return;
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const sdp = connection.localDescription?.sdp ?? "";
      const res = await fetch(`/voice/live?session=${opts.current.session}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp }) });
      const made: { ok: boolean; why: string; liveId?: string; sdp?: string; maxSeconds?: number; greeting?: string } = await res.json();
      if (!made.ok || !made.sdp || !made.liveId) throw new Error(made.why || "The conversation could not be started just now.");
      liveId.current = made.liveId;
      greeting = made.greeting ?? "";
      setLimit(made.maxSeconds ?? 150);
      setSeconds(0);
      await connection.setRemoteDescription({ type: "answer", sdp: made.sdp });
      // The server ends it at the limit whatever this page does; ending it here first is only politer.
      closing.current = setTimeout(stop, ((made.maxSeconds ?? 150) - 3) * 1000);
    } catch (e) {
      const why = e instanceof DOMException && e.name === "NotAllowedError" ? "The microphone is blocked for this page. Allow it in the address bar, or type it." : e instanceof Error ? e.message : "The conversation could not be started just now.";
      opts.current.refuse(why);
      cleanup();
    }
  }, [cleanup, delegated, stop]);

  // A page that is going away ends its conversation.
  useEffect(() => () => void (peer.current && cleanup()), [cleanup]);

  return { state, seconds, limit, heard, voice, start, stop, speak };
}
