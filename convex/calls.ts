import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "../engine/canon";
import { answersFromCall, callResultSchema, callTask, normalisePhone, type CallAnswer, type CallQuestion } from "../engine/call";

// CALL ME: the questions, put to a person on the phone.
//
// Someone who has been asked about a building can have their phone rung instead
// of typing. They ask for it in their own message - "CALL ME +1 718 555 0142",
// read with no model, or a sentence, read by GPT-6 Astra, which may pick the
// call_me tool. CALL-E places the call on its own line and speaks the script in
// engine/call.ts. What comes back is a violation number and one of three words
// for each repair. Before any of it is recorded the transcript is read a second
// time, by GPT-6 Astra, which is not told what CALL-E made of it; an answer
// stands only where the two agree (engine/call.ts, settle), and where they do
// not, the person is asked again in writing. What stands is recorded by the
// same mutation the agent's record_answer tool uses - including its refusal of
// a number this person was never asked about. The reply goes wherever they
// wrote from: the email thread, the text thread, or the browser.
//
// A thing that can ring a telephone is a thing to be careful with:
//   - the number must be written, by them, in the message that asks for the call:
//     a model can pick the wrong tool, but it cannot ring a number nobody wrote;
//   - one number is rung at most twice a day, one person twice, all of us twelve times;
//   - the call says at once that it is automated and was asked for, and someone who
//     says they did not ask is never rung again (the list a spam complaint goes on);
//   - what the voice may say is written by the tools;
//   - the number is not kept in our tables: a hash of it for the limits and the
//     do-not-call list, and its last four digits so they can see which phone will ring.
//     (It goes to CALL-E, which has to ring it, and it rides in the scheduler's job
//     record for this action until Convex clears that.)
//
// CALL-E's webhooks are unsigned, so nothing in one is believed: it names a call,
// and the call is then read back from CALL-E's API with our own key.

const API = () => process.env.CALLE_BASE_URL ?? "https://api.heycall-e.com";
const INBOX = () => process.env.AGENTMAIL_INBOX_ID ?? "getnotice@agentmail.to";
const TERMINAL = new Set(["completed", "failed", "canceled"]);

/** Ring them. Reached from the CALL ME keyword and from the agent's call_me tool; both pass the message that asked. */
export const start = internalAction({
  args: { inboxId: v.id("inbox"), phone: v.string() },
  returns: v.string(),
  handler: async (ctx, { inboxId, phone }): Promise<string> => {
    const to = normalisePhone(phone);
    if (!to) {
      await ctx.runMutation(internal.inbound.callRefused, { inboxId, why: "that doesn't look like a US or Indian phone number. Write CALL ME and the number with its country code, like +1 718 555 0142" });
      return "not a number we can ring";
    }
    const key = process.env.CALLE_API_KEY;
    if (!key) {
      await ctx.runMutation(internal.inbound.callRefused, { inboxId, why: "calls aren't switched on yet" });
      return "calls are not switched on";
    }

    // Every check that can refuse the call happens before the number goes anywhere.
    const phoneHash = await sha256Hex(`faultline-call:${to.e164}`);
    const asked: { ok: boolean; why: string; callRow?: Id<"calls">; questions?: CallQuestion[] } = await ctx.runMutation(internal.inbound.callRequested, {
      inboxId,
      phoneHash,
      tail: to.e164.slice(-4),
    });
    if (!asked.ok || !asked.callRow || !asked.questions) return asked.why;

    const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
    try {
      const res = await fetch(`${API()}/v1/calls`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": String(asked.callRow) },
        body: JSON.stringify({
          task: callTask(asked.questions, INBOX()),
          recipients: [{ phones: [to.e164], region: to.region, locale: to.locale }],
          result_schema: callResultSchema(asked.questions.map((q) => q.violationId)),
          metadata: { faultline_call: String(asked.callRow) },
          ...(site ? { webhook_url: `${site}/hooks/calle` } : {}),
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.id) throw new Error(`CALL-E ${res.status}: ${String(data?.error?.code ?? data?.code ?? data?.message ?? "").slice(0, 120)}`);
      await ctx.runMutation(internal.calls.placed, { callRow: asked.callRow, callId: String(data.id) });
      // The webhook is the quick way to hear it ended; these are the sure one.
      for (const s of [40, 80, 130, 190, 260, 360, 520]) await ctx.scheduler.runAfter(s * 1000, internal.calls.reconcile, { callId: String(data.id) });
      console.log(`[calls] placed ${String(data.id)} to a number ending ${to.e164.slice(-4)}, ${asked.questions.length} question(s)`);
      return "calling them now, and told them so";
    } catch (e) {
      console.error(`[calls] could not place the call: ${String(e)}`);
      await ctx.runMutation(internal.inbound.callFinished, { callRow: asked.callRow, status: "failed", answers: [], declined: false, reached: false, turns: [], why: "the call could not be placed" });
      return "the call could not be placed; told them so";
    }
  },
});

export const placed = internalMutation({
  args: { callRow: v.id("calls"), callId: v.string() },
  returns: v.null(),
  handler: async (ctx, { callRow, callId }) => {
    await ctx.db.patch(callRow, { callId, status: "ringing" });
    return null;
  },
});

export const underWay = internalMutation({
  args: { callRow: v.id("calls") },
  returns: v.null(),
  handler: async (ctx, { callRow }) => {
    const row = await ctx.db.get(callRow);
    if (row && row.finishedAt === undefined && row.status === "ringing") await ctx.db.patch(callRow, { status: "on the call" });
    return null;
  },
});

export const byCallId = internalQuery({
  args: { callId: v.string() },
  returns: v.union(v.null(), v.object({ callRow: v.id("calls"), done: v.boolean(), asked: v.array(v.string()) })),
  handler: async (ctx, { callId }) => {
    const row = await ctx.db.query("calls").withIndex("by_call", (q) => q.eq("callId", callId)).unique();
    return row ? { callRow: row._id, done: row.finishedAt !== undefined, asked: row.asked } : null;
  },
});

/** What the second reader is given: the questions, the transcript, and - for the comparison afterwards only - what CALL-E heard. */
export const forReading = internalQuery({
  args: { callRow: v.id("calls") },
  returns: v.union(
    v.null(),
    v.object({
      identity: v.string(),
      asked: v.array(v.string()),
      questions: v.array(v.object({ violationId: v.string(), description: v.string(), statusDate: v.string() })),
      turns: v.array(v.object({ who: v.string(), text: v.string() })),
      heard: v.array(v.object({ violationId: v.string(), answer: v.union(v.literal("fixed"), v.literal("still_broken"), v.literal("not_sure")), words: v.string() })),
    }),
  ),
  handler: async (ctx, { callRow }) => {
    const row = await ctx.db.get(callRow);
    if (!row || row.finishedAt !== undefined || row.status !== "reading") return null;
    return { identity: row.identity, asked: row.asked, questions: row.questions ?? [], turns: row.turns ?? [], heard: row.heard ?? [] };
  },
});

/** Read the call back from CALL-E with our own key. A webhook only ever says which call to read. */
export const reconcile = internalAction({
  args: { callId: v.string() },
  returns: v.null(),
  handler: async (ctx, { callId }): Promise<null> => {
    const key = process.env.CALLE_API_KEY;
    if (!key || !/^[\w-]{3,80}$/.test(callId)) return null;
    const known: { callRow: Id<"calls">; done: boolean; asked: string[] } | null = await ctx.runQuery(internal.calls.byCallId, { callId });
    if (!known || known.done) return null;
    const res = await fetch(`${API()}/v1/calls/${encodeURIComponent(callId)}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      console.warn(`[calls] could not read ${callId}: ${res.status}`);
      return null;
    }
    const call: any = await res.json();
    const status = String(call?.status ?? "");
    if (!TERMINAL.has(status)) {
      // Not over. If CALL-E says it is under way, the thread that asked can say so too.
      if (status === "in_progress") await ctx.runMutation(internal.calls.underWay, { callRow: known.callRow });
      return null;
    }
    const attempts: any[] = (call?.recipients ?? []).flatMap((r: any) => r?.attempts ?? []);
    const turns: { who: string; text: string }[] = attempts
      .flatMap((a: any) => a?.transcript_turns ?? [])
      .slice(0, 60)
      .map((t: any) => ({ who: String(t?.speaker ?? "") === "user" ? "you" : "call", text: String(t?.text ?? "").slice(0, 400) }))
      .filter((t: { text: string }) => t.text.length > 0);
    // Cut down to what we accept before it reaches a mutation: repairs we asked
    // about, the three words, one answer each (engine/call.ts).
    const got: { answers: CallAnswer[]; declined: boolean; reached: boolean } = answersFromCall(
      call?.structured_result ?? (call?.recipients ?? [])[0]?.structured_result ?? null,
      known.asked,
    );
    await ctx.runMutation(internal.inbound.callFinished, {
      callRow: known.callRow,
      status,
      answers: got.answers,
      declined: got.declined,
      reached: got.reached || turns.some((t) => t.who === "you"),
      turns,
      why: String(call?.failure_code ?? attempts.at(-1)?.failure_code ?? ""),
    });
    console.log(`[calls] ${callId} ${status}: ${got.answers.length} answer(s), ${turns.length} turn(s)${got.declined ? ", declined" : ""}`);
    return null;
  },
});
