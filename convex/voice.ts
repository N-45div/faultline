import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { costCents } from "./llm";
import { LIVE_GREETING, LIVE_INSTRUCTIONS, LIVE_MAX_SECONDS } from "../engine/live";

// The browser trial, by voice.
//
// Plenty of the people this is for would rather say it than type it. On /try a
// person can hold a button and answer out loud, and have any reply read back.
//
//   POST /voice/hear   the recording -> OpenAI transcription -> the same door a
//                      typed message uses (web.say). The recording is never
//                      stored: it is transcribed and dropped, and what we keep
//                      is what we would keep of an email, the words.
//   GET  /voice/say    one of OUR replies -> OpenAI speech, streamed. It speaks only a
//                      receipt that belongs to the asking browser's thread, in
//                      the words the tool wrote (engine/speech.ts makes them
//                      sayable, and adds none): this is not a free voice for
//                      whatever text someone sends.
//
//   POST /voice/live   a conversation. The browser sends its WebRTC offer; we
//                      make a gpt-live-1 session with our key and our
//                      instructions and hand back the answer. The audio goes
//                      between the browser and OpenAI; what the person asks
//                      for comes back through web.say, the door typing uses,
//                      and the reply a tool wrote is handed to the voice to
//                      say (engine/live.ts). The server ends every
//                      conversation at two and a half minutes (liveActions.ts).
//
// So the rule holds for the first two: the model writes no sentence anyone
// hears; it writes down theirs, and reads out ours. A conversation cannot keep
// it to the letter - gpt-live-1 puts a result into its own spoken words - so
// there the page says what is true: the written reply is the record, and the
// voice is not.

const HEAR_MODELS = () => [process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe", "whisper-1"];
const SAY_MODELS = () => [process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts", "tts-1"];
const VOICE = () => process.env.OPENAI_TTS_VOICE ?? "sage";

/** Words a transcriber would otherwise mishear, in the order a tenant would say them. */
const HINT =
  "A tenant in New York City talking about a repair in their building: HPD, violation, certified, landlord, super, tiles, ceiling, plaster, leak, radiator, compactor, latch, still broken, fixed, not sure.";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** A multipart body by hand: a file and a few fields. Nothing here depends on the runtime's FormData. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; bytes: Uint8Array }): { body: Uint8Array; type: string } {
  const boundary = `----faultline${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, val] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${val}\r\n`));
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.bytes);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

const MIME: Record<string, string> = { webm: "audio/webm", mp4: "audio/mp4", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" };

export const hear = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const session = url.searchParams.get("session") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const ext = (url.searchParams.get("ext") ?? "webm").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  if (!MIME[ext]) return json({ ok: false, why: "This browser records in a format we can't read yet. Type it instead." });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ ok: false, why: "Voice is switched off right now. Type it instead." });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length < 1_500) return json({ ok: false, why: "We didn't catch anything. Press the button, say it, and press again." });
  if (bytes.length > 2_500_000) return json({ ok: false, why: "That ran long. Keep it under a minute, or type it." });

  // Paid for before the model is called, from the trial's own room.
  const room: { ok: boolean; why: string } = await ctx.runMutation(internal.web.allowVoice, { session, what: "hear" });
  if (!room.ok) return json(room);

  let text = "";
  let model = "";
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  for (const m of HEAR_MODELS()) {
    const form = multipart({ model: m, response_format: "json", prompt: HINT }, { name: `speech.${ext}`, type: MIME[ext], bytes });
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": form.type },
      // The same cast the page-keeper uses: the runtime takes bytes, the DOM types want a BodyInit.
      body: new Blob([form.body as BlobPart]),
    });
    if (res.ok) {
      const data: any = await res.json();
      text = String(data?.text ?? "").replace(/\s+/g, " ").trim();
      usage = data?.usage;
      model = m;
      break;
    }
    console.warn(`[voice] ${m} could not transcribe: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  if (!model) return json({ ok: false, why: "We couldn't hear that just now. Try again, or type it." });
  if (text.length < 2) return json({ ok: false, why: "We couldn't make out any words. Try again a little closer to the microphone." });

  await ctx.runMutation(internal.llm.recordUsage, {
    model,
    purpose: "hear",
    inputTokens: Number(usage?.input_tokens ?? 0),
    cachedTokens: 0,
    outputTokens: Number(usage?.output_tokens ?? 0),
    costCents: costCents(model, { input_tokens: Number(usage?.input_tokens ?? 0), output_tokens: Number(usage?.output_tokens ?? 0) }),
  });
  const out: { ok: boolean; why: string } = await ctx.runMutation(internal.web.sayHeard, { session, id, text: text.slice(0, 600), heardBy: model });
  console.log(`[voice] heard ${bytes.length} bytes of ${ext} with ${model}: ${text.length} characters`);
  return json({ ...out, text: text.slice(0, 600), heardBy: model });
});

export const say = httpAction(async (ctx, request) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ ok: false, why: "Voice is switched off right now." }, 503);
  // A GET, so the page's own <audio> element can play it while it is still
  // arriving: a reply takes ten seconds to speak in full and half a second to begin.
  const url = new URL(request.url);
  const session = url.searchParams.get("session") ?? "";
  const replyId = url.searchParams.get("reply") ?? "";
  // Only a reply that is in this browser's own thread, and only as the tool wrote it.
  const text: string | null = await ctx.runQuery(internal.web.spokenReply, { session, replyId });
  if (!text) return json({ ok: false, why: "That reply isn't in this thread." }, 404);
  const room: { ok: boolean; why: string } = await ctx.runMutation(internal.web.allowVoice, { session, what: "speak" });
  if (!room.ok) return json(room, 429);

  for (const m of SAY_MODELS()) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: m,
        voice: VOICE(),
        input: text,
        response_format: "mp3",
        ...(m.startsWith("gpt-") ? { instructions: "Read this the way a clerk reads a record back to the person it is about: calm, plain, unhurried, no drama. Say the digits of a violation number one at a time." } : {}),
      }),
    });
    if (res.ok) {
      await ctx.runMutation(internal.llm.recordUsage, { model: m, purpose: "speak", inputTokens: text.length, cachedTokens: 0, outputTokens: 0, costCents: 0 });
      console.log(`[voice] spoke ${text.length} characters with ${m}`);
      return new Response(res.body, { status: 200, headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
    }
    console.warn(`[voice] ${m} could not speak: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  return json({ ok: false, why: "We couldn't read that aloud just now." }, 502);
});

const LIVE_MODEL = () => process.env.OPENAI_LIVE_MODEL ?? "gpt-live-1";

export const live = httpAction(async (ctx, request) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ ok: false, why: "Voice is switched off right now. Type it instead." }, 503);
  const session = new URL(request.url).searchParams.get("session") ?? "";
  let sdp = "";
  try {
    sdp = String(((await request.json()) as { sdp?: unknown })?.sdp ?? "");
  } catch {
    /* no offer */
  }
  if (!sdp.startsWith("v=0") || sdp.length > 60_000) return json({ ok: false, why: "This browser could not start a conversation. Say it or type it instead." }, 400);

  // Paid for before the model is called, from a room of its own.
  const room: { ok: boolean; why: string } = await ctx.runMutation(internal.web.allowVoice, { session, what: "live" });
  if (!room.ok) return json(room, 429);

  const res = await fetch("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // Client delegation: when the voice needs anything done it asks the page, and the page asks us.
      session: { model: LIVE_MODEL(), instructions: LIVE_INSTRUCTIONS, delegation: { type: "client" } },
      transport: { type: "webrtc", sdp },
    }),
  });
  if (!res.ok) {
    console.warn(`[live] ${LIVE_MODEL()} would not start: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return json({ ok: false, why: "The conversation could not be started just now. Say it or type it instead." }, 502);
  }
  const made: any = await res.json();
  const liveId = String(made?.session?.id ?? "");
  const answer = String(made?.transport?.sdp ?? "");
  if (!liveId || !answer) return json({ ok: false, why: "The conversation could not be started just now. Say it or type it instead." }, 502);
  await ctx.runMutation(internal.web.liveStarted, { session, liveId });
  console.log(`[live] started ${liveId.slice(0, 12)}… with ${LIVE_MODEL()}, to be ended by ${LIVE_MAX_SECONDS}s`);
  return json({ ok: true, why: "", liveId, sdp: answer, maxSeconds: LIVE_MAX_SECONDS, greeting: LIVE_GREETING }, 201);
});
