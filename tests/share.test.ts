/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { api, internal } from "../convex/_generated/api";

// A record sent on: after an answer is kept on /try, the agent writes from its
// own inbox to someone helping the tenant, the page watches the letter go out,
// and their reply lands beside the record. AgentMail is stood in for at fetch.

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};
type T = ReturnType<typeof make>;

const SESSION = "a".repeat(32);
const OTHER = "b".repeat(32);
const VIOLATION = "19112934";
const HELPER = "organizer@example.org";
const NOTE = "BUY PILLS http://spam.example";

let sends: { url: string; headers: Record<string, string>; body: any }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("AGENTMAIL_API_KEY", "am-test");
  vi.stubEnv("AGENTMAIL_INBOX_ID", "getnotice@agentmail.to");
  vi.stubEnv("CONVEX_SITE_URL", "https://faultline.test");
  sends = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).includes("/messages/send")) {
      sends.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body });
      return new Response(JSON.stringify({ message_id: `<share-${sends.length}@agentmail.to>`, thread_id: `share-thread-${sends.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A repair asked about on this page and answered, with a note the model passed on. */
async function answered(t: T, session = SESSION) {
  await t.run(async (ctx) => {
    await ctx.db.insert("attestations", {
      email: `web:${session}`,
      subjectKey: "3050840061",
      violationId: VIOLATION,
      askedAt: Date.UTC(2026, 8, 22),
      askedStatus: "NOV CERTIFIED ON TIME",
      askedStatusDate: "2026-09-18",
      certifiedBy: "2026-09-18",
      hazardClass: "B",
      description: "§ 27-2005 ADM CODE REPAIR THE BROKEN OR DEFECTIVE PLASTERED SURFACES IN THE KITCHEN LOCATED AT APT 4A, 4th STORY, 1st APARTMENT FROM NORTH AT EAST",
      answer: "still_broken",
      saidAt: Date.UTC(2026, 8, 22, 6, 30),
      note: NOTE,
    });
  });
}

async function share(t: T, to: string, session = SESSION) {
  const r = await t.mutation(api.share.send, { session, violationId: VIOLATION, to });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return r;
}

const mine = (t: T, session = SESSION) => t.query(api.share.forSession, { session });

test("nothing is sent for a repair not answered on this page, to an agent inbox, or to a malformed address", async () => {
  const t = make();
  expect((await share(t, HELPER)).ok).toBe(false);
  await answered(t);
  expect((await share(t, HELPER, OTHER)).ok).toBe(false);
  expect((await share(t, "loop@agentmail.to")).ok).toBe(false);
  expect((await share(t, "not an address")).ok).toBe(false);
  expect(sends).toHaveLength(0);
});

test("the agent writes from its own inbox, once, with the city's record and the tapped answer, and never the note", async () => {
  const t = make();
  await answered(t);
  expect(await share(t, HELPER)).toEqual({ ok: true });
  expect(sends).toHaveLength(1);
  const [s] = sends;
  expect(s.url).toContain("/inboxes/getnotice%40agentmail.to/messages/send");
  expect(s.body.to).toEqual([HELPER]);
  expect(s.headers["Idempotency-Key"]).toMatch(/^share-/);
  expect(s.body.text).toContain(`#${VIOLATION}`);
  expect(s.body.text).toContain("STILL BROKEN");
  expect(s.body.text).toContain("NOV CERTIFIED ON TIME");
  // What the model passed on as a note is not the tenant's to send, and nothing typed is.
  expect(JSON.stringify(s.body)).not.toContain("BUY PILLS");
  expect(JSON.stringify(s.body)).not.toContain("spam.example");
  // The letter leaves out which home it is.
  expect(s.body.text).not.toContain("APT 4A");
  const [row] = await mine(t);
  expect(row).toMatchObject({ violationId: VIOLATION, to: "o•••@example.org", status: "sent" });
  expect(JSON.stringify(await mine(t))).not.toContain(HELPER);
});

test("one letter a day to any one address, and three a day from one page", async () => {
  const t = make();
  await answered(t);
  expect((await share(t, HELPER)).ok).toBe(true);
  expect(await share(t, HELPER)).toMatchObject({ ok: false });
  expect((await share(t, "two@example.org")).ok).toBe(true);
  expect((await share(t, "three@example.org")).ok).toBe(true);
  expect(await share(t, "four@example.org")).toMatchObject({ ok: false, why: expect.stringMatching(/three letters/) });
  expect(sends).toHaveLength(3);
});

test("AgentMail's delivery event shows on the page, and their reply lands beside the record, from them only", async () => {
  const t = make();
  await answered(t);
  await share(t, HELPER);
  await t.mutation(internal.inbound.onMailEvent, { event: { event_type: "message.delivered", delivery: { message_id: "<share-1@agentmail.to>" } } });
  expect((await mine(t))[0].status).toBe("delivered");
  // A late "sent" does not undo delivered.
  await t.mutation(internal.inbound.onMailEvent, { event: { event_type: "message.sent", send: { message_id: "<share-1@agentmail.to>" } } });
  expect((await mine(t))[0].status).toBe("delivered");

  // Someone else writing into the same thread is not their reply; they are just writing to us.
  await t.mutation(internal.inbound.onMessageReceived, {
    message: { message_id: "<x@elsewhere>", thread_id: "share-thread-1", inbox_id: "getnotice@agentmail.to", from: "Someone <someone@else.org>", subject: "Re: Repair", text: "not me" },
    thread: {},
    eventId: "x",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await mine(t))[0].replies).toEqual([]);
  const receiptsBefore = (await t.run((ctx) => ctx.db.query("receipts").collect())).length;
  const sendsBefore = sends.length;
  await t.mutation(internal.inbound.onMessageReceived, {
    message: { message_id: "<r1@example.org>", thread_id: "share-thread-1", inbox_id: "getnotice@agentmail.to", from: `Org <${HELPER}>`, subject: "Re: Repair", text: "Still dripping, I saw it Sunday." },
    thread: {},
    eventId: "r1",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [row] = await mine(t);
  expect(row.replies.map((r) => r.text)).toEqual(["Still dripping, I saw it Sunday."]);
  // Their reply is kept, not answered: no receipt, and nothing sent back.
  expect((await t.run((ctx) => ctx.db.query("receipts").collect())).length).toBe(receiptsBefore);
  expect(sends).toHaveLength(sendsBefore);
});

/** A message into a letter's thread, as AgentMail passes it on. */
async function reply(t: T, id: string, from: string, text: string, thread = "share-thread-1") {
  await t.mutation(internal.inbound.onMessageReceived, {
    message: { message_id: `<${id}@example.org>`, thread_id: thread, inbox_id: "getnotice@agentmail.to", from, subject: "Re: Repair", text },
    thread: {},
    eventId: id,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

test("every reply from them is kept, in the order it came, and a reply from anyone else is not", async () => {
  const t = make();
  await answered(t);
  await share(t, HELPER);
  const first = Date.now() + 60_000;
  const second = first + 3_600_000;
  vi.setSystemTime(first);
  await reply(t, "r1", `Org <${HELPER}>`, "Still dripping, I saw it Sunday.");
  vi.setSystemTime(first + 60_000);
  await reply(t, "x", "Someone <someone@else.org>", "not me");
  vi.setSystemTime(second);
  await reply(t, "r2", HELPER, "The super came by  today.\n\nStill broken.");
  const [row] = await mine(t);
  expect(row.replies).toEqual([
    { text: "Still dripping, I saw it Sunday.", at: first },
    { text: "The super came by today. Still broken.", at: second },
  ]);
  expect(JSON.stringify(await mine(t))).not.toContain(HELPER);
});

test("each reply is cut at 500 characters, and a letter keeps its last 20", async () => {
  const t = make();
  await answered(t);
  await share(t, HELPER);
  await reply(t, "long", HELPER, "x".repeat(900));
  expect((await mine(t))[0].replies[0].text).toHaveLength(500);
  for (let i = 1; i <= 21; i++) await reply(t, `n${i}`, HELPER, `reply ${i}`);
  const { replies } = (await mine(t))[0];
  expect(replies).toHaveLength(20);
  expect(replies[0].text).toBe("reply 2");
  expect(replies[19].text).toBe("reply 21");
});

test("a letter from before replies were kept as a list shows its one reply, and the next comes after it", async () => {
  const t = make();
  const at = Date.now() - 3_600_000;
  await t.run(async (ctx) => {
    await ctx.db.insert("shares", {
      session: SESSION,
      violationId: VIOLATION,
      to: HELPER,
      status: "delivered",
      createdAt: at - 600_000,
      outboundId: "<share-old@agentmail.to>",
      mailThreadId: "share-thread-old",
      statusAt: at - 300_000,
      replyText: "Got it, I'm calling HPD.",
      replyAt: at,
    });
  });
  expect((await mine(t))[0].replies).toEqual([{ text: "Got it, I'm calling HPD.", at }]);
  await reply(t, "r-old", HELPER, "They came Tuesday.", "share-thread-old");
  expect((await mine(t))[0].replies.map((r) => r.text)).toEqual(["Got it, I'm calling HPD.", "They came Tuesday."]);
});

/** AgentMail answering the send with this instead of a message id. */
function sendAnswers(answer: () => Response) {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/messages/send")) {
      sends.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) });
      return answer();
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("AgentMail answering with an error status: the page says nothing was sent", async () => {
  const t = make();
  await answered(t);
  sendAnswers(() => json({ message: "invalid recipient" }, 422));
  expect(await share(t, HELPER)).toEqual({ ok: true });
  expect(sends).toHaveLength(1);
  expect((await mine(t))[0]).toMatchObject({ status: "failed", why: "AgentMail didn't take it. Nothing was sent." });
});

test("no answer from AgentMail: the page says delivery could not be confirmed, not that nothing was sent, and nothing sends it again", async () => {
  const t = make();
  await answered(t);
  const answers: [string, () => Response][] = [
    ["dropped@example.org", () => { throw new TypeError("fetch failed"); }],
    ["unread@example.org", () => new Response("<html>ok</html>", { status: 200 })],
    ["gateway@example.org", () => json({ message: "upstream timed out" }, 504)],
  ];
  for (const [to, answer] of answers) {
    sendAnswers(answer);
    expect(await share(t, to)).toEqual({ ok: true });
  }
  expect(sends).toHaveLength(3);
  for (const row of await mine(t)) {
    expect(row.status).toBe("unconfirmed");
    expect(row.why).toMatch(/^Delivery could not be confirmed\./);
    expect(row.why).not.toMatch(/Nothing was sent/);
  }
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sends).toHaveLength(3);
});

const event = (event_type: string, part: string, body: Record<string, unknown>) =>
  ({ event: { event_type, [part]: { inbox_id: "getnotice@agentmail.to", ...body } } });

test("an unconfirmed letter is matched to AgentMail's later event only by its own label, never by the address", async () => {
  const t = make();
  await answered(t);
  sendAnswers(() => {
    throw new TypeError("fetch failed");
  });
  await share(t, HELPER);
  await share(t, "gone@example.org");
  const status = async (to: string) => (await mine(t)).find((r) => r.to === to)?.status;
  expect(await status("o•••@example.org")).toBe("unconfirmed");
  expect(await status("g•••@example.org")).toBe("unconfirmed");
  // Each send carried a label that is its own: share-<id>.
  const label = (to: string) => (sends.find((s) => s.body.to?.[0] === to)!.body.labels as string[]).find((l) => l !== "share")!;
  expect(label(HELPER)).toMatch(/^share-\w+$/);
  expect(label("gone@example.org")).not.toBe(label(HELPER));

  // Another page's letter to the same helper, also never confirmed.
  const other = await t.run((ctx) =>
    ctx.db.insert("shares", { session: "b".repeat(32), violationId: VIOLATION, to: HELPER, status: "unconfirmed", createdAt: Date.now() }),
  );
  const otherStatus = async () => (await t.run((ctx) => ctx.db.get(other)))!.status;

  // An event naming only the address could be either letter, so it moves neither.
  await t.mutation(internal.inbound.onMailEvent, event("message.delivered", "delivery", { message_id: "<late@agentmail.to>", thread_id: "share-thread-late", recipients: [HELPER] }));
  expect(await status("o•••@example.org")).toBe("unconfirmed");
  expect(await otherStatus()).toBe("unconfirmed");

  // The event carrying this letter's own label moves this letter, and only it.
  await t.mutation(internal.inbound.onMailEvent, event("message.delivered", "delivery", { message_id: "<late@agentmail.to>", thread_id: "share-thread-late", recipients: [HELPER], labels: ["share", label(HELPER)] }));
  const row = (await mine(t)).find((r) => r.to === "o•••@example.org")!;
  expect(row.status).toBe("delivered");
  expect(row.why).toBeUndefined();
  expect(await otherStatus()).toBe("unconfirmed");
  // A late "sent" for it does not undo delivered.
  await t.mutation(internal.inbound.onMailEvent, event("message.sent", "send", { message_id: "<late@agentmail.to>", thread_id: "share-thread-late", recipients: [HELPER] }));
  expect(await status("o•••@example.org")).toBe("delivered");

  await t.mutation(internal.inbound.onMailEvent, event("message.bounced", "bounce", { message_id: "<gone@agentmail.to>", thread_id: "share-thread-gone", type: "Permanent", recipients: [{ address: "gone@example.org", status: "5.1.1" }], labels: ["share", label("gone@example.org")] }));
  expect(await status("g•••@example.org")).toBe("bounced");

  // The letter now has its thread, so their reply lands beside it, and nothing goes back.
  await reply(t, "r-late", HELPER, "Got it, thanks.", "share-thread-late");
  expect((await mine(t)).find((r) => r.to === "o•••@example.org")!.replies.map((r) => r.text)).toEqual(["Got it, thanks."]);
  expect(sends).toHaveLength(2);
});

test("STOP from them is final: marked on the page, and the address gets nothing more", async () => {
  const t = make();
  await answered(t);
  await share(t, HELPER);
  await t.mutation(internal.inbound.onMessageReceived, {
    message: { message_id: "<stop@example.org>", thread_id: "share-thread-1", inbox_id: "getnotice@agentmail.to", from: HELPER, subject: "STOP", text: "STOP" },
    thread: {},
    eventId: "stop",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await mine(t))[0].stopped).toBe(true);
  await answered(t, OTHER);
  expect(await share(t, HELPER, OTHER)).toMatchObject({ ok: false, why: expect.stringMatching(/stop/i) });
  expect(sends).toHaveLength(1);
});
