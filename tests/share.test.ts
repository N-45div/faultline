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
  expect((await mine(t))[0].replyText).toBeUndefined();
  const receiptsBefore = (await t.run((ctx) => ctx.db.query("receipts").collect())).length;
  const sendsBefore = sends.length;
  await t.mutation(internal.inbound.onMessageReceived, {
    message: { message_id: "<r1@example.org>", thread_id: "share-thread-1", inbox_id: "getnotice@agentmail.to", from: `Org <${HELPER}>`, subject: "Re: Repair", text: "Still dripping, I saw it Sunday." },
    thread: {},
    eventId: "r1",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [row] = await mine(t);
  expect(row.replyText).toBe("Still dripping, I saw it Sunday.");
  // Their reply is kept, not answered: no receipt, and nothing sent back.
  expect((await t.run((ctx) => ctx.db.query("receipts").collect())).length).toBe(receiptsBefore);
  expect(sends).toHaveLength(sendsBefore);
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
