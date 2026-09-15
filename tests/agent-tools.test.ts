/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import agentmailTest from "@agentmail/convex/test";
import workpoolTest from "@convex-dev/workpool/test";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// The agent's hands, without the model. GPT-6 Astra chooses a tool; these
// tests call the tools the way it would and check what the person receives,
// and that free text reaches the agent instead of the keyword reader. The
// model itself is verified live, against the real inbox.

const modules = import.meta.glob("../convex/**/*.*s");
// Replies go through the AgentMail component, which runs on two workpools.
// Its published test helper globs only .ts files, but the package ships its
// _generated directory as .js, so convex-test cannot find the component's
// root; the glob here includes both.
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.*s");
const make = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("agentmail", agentmailTest.schema as any, agentmailModules);
  workpoolTest.register(t as any, "agentmail/sendPool");
  workpoolTest.register(t as any, "agentmail/callbackPool");
  return t;
};
type T = ReturnType<typeof make>;

const BBL = "3050840061";
const VIOLATION = "19114271";
const TENANT = "tenant@example.com";
const LABEL = "155 LINDEN BOULEVARD, Brooklyn";
const FIELDS = {
  violationid: VIOLATION,
  bbl: BBL,
  class: "A",
  currentstatus: "NOV CERTIFIED ON TIME",
  currentstatusdate: "2026-09-10",
  certifiedbydate: "2026-09-10",
  novdescription: "POST A PROPER NOTICE REGARDING RENT STABILIZATION LAW",
  __subjectKind: "building",
  __subjectKey: BBL,
  __subjectLabel: LABEL,
};

type Sent = { url: string; body: { text?: string } };
let sent: Sent[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  vi.stubEnv("AGENTMAIL_INBOX_ID", "getnotice@agentmail.to");
  vi.stubEnv("AGENTMAIL_API_KEY", "test-key");
  vi.stubEnv("CONVEX_SITE_URL", "https://faultline.test");
  vi.stubEnv("NOTICE_POSTAL", "1 Test Street, New York, NY 10001");
  vi.stubEnv("OPENAI_API_KEY", "");
  sent = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ message_id: `<out-${sent.length}@test>`, thread_id: "thread-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function seed(t: T) {
  await t.run(async (ctx) => {
    const sourceId = await ctx.db.insert("sources", {
      slug: "nyc-hpd",
      adapterVersion: 1,
      status: "active",
      emit: true,
      nextRunAt: 0,
      consecutiveFailures: 0,
      shadowCycles: 0,
    });
    await ctx.db.insert("subjects", { kind: "building", key: BBL, label: LABEL });
    const snapshotId = await ctx.db.insert("snapshots", {
      sourceId,
      capturedAt: Date.now(),
      requestUrl: "https://city.test/file",
      httpStatus: 200,
      bodySha256: "0".repeat(64),
      rowCount: 1,
      degraded: false,
    });
    const identityKey = `${BBL}/${VIOLATION}`;
    const observationId = await ctx.db.insert("observations", {
      sourceId,
      snapshotId,
      identityKey,
      subjectKey: BBL,
      claimKind: "hpd.violation_status",
      assertedAt: "2026-09-10",
      capturedAt: Date.now(),
      fields: FIELDS,
      sigHash: "s",
      fullHash: "f",
    });
    await ctx.db.insert("current", { sourceId, identityKey, subjectKey: BBL, observationId, sigHash: "s", fullHash: "f", fields: FIELDS, updatedAt: Date.now() });
    await ctx.db.insert("inbox", {
      messageId: "<m0@test>",
      threadId: "thread-1",
      inboxId: "getnotice@agentmail.to",
      fromAddress: TENANT,
      subject: LABEL,
      receivedAt: Date.now() - 60_000,
      authenticated: true,
      intent: "lookup",
      query: LABEL,
      matchedSubjectKey: BBL,
      bodyHash: "h0",
      replied: true,
    });
  });
}

async function receive(t: T, id: string, subject: string, text: string): Promise<string> {
  const message = { message_id: id, thread_id: "thread-1", inbox_id: "getnotice@agentmail.to", from: `A Tenant <${TENANT}>`, subject, text };
  const before = sent.length;
  await t.mutation(internal.inbound.onMessageReceived, { message, thread: {}, eventId: id });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return sent.length > before ? (sent[sent.length - 1].body.text ?? "") : "";
}

/** The message the agent is working on, as the inbound handler stored it. */
async function incoming(t: T, id: string): Promise<Id<"inbox">> {
  return await t.run((ctx) =>
    ctx.db.insert("inbox", {
      messageId: id,
      threadId: "thread-1",
      inboxId: "getnotice@agentmail.to",
      fromAddress: TENANT,
      subject: `Re: ${LABEL}`,
      receivedAt: Date.now(),
      authenticated: true,
      intent: "agent",
      query: "agent",
      bodyHash: id,
      replied: false,
    }),
  );
}

async function lastReply(t: T): Promise<string> {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return sent[sent.length - 1]?.body.text ?? "";
}

test("a free-text reply to one of our questions goes to the agent, not the keyword reader", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  const before = sent.length;

  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  const message = {
    message_id: "<m2@test>",
    thread_id: "thread-1",
    inbox_id: "getnotice@agentmail.to",
    from: `A Tenant <${TENANT}>`,
    subject: `Re: ${LABEL}`,
    text: "the super painted over the stain but water still comes through",
  };
  await t.mutation(internal.inbound.onMessageReceived, { message, thread: {}, eventId: "e2" });
  const row = await t.run((ctx) => ctx.db.query("inbox").withIndex("by_message_id", (q) => q.eq("messageId", "<m2@test>")).unique());
  expect(row?.intent).toBe("agent");
  expect(sent.length).toBe(before);
});

test("the answer tool records the answer, says how the reply was read, and follows the building", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  const inboxId = await incoming(t, "<m2@test>");

  const out = await t.mutation(internal.inbound.agentRecordAnswer, {
    inboxId,
    violationId: VIOLATION,
    answer: "still_broken",
    note: "water still comes through",
  });
  expect(out).toBe("recorded and replied");
  const reply = await lastReply(t);
  expect(reply).toContain(`We read your reply as still broken, about #${VIOLATION}.`);
  expect(reply).toContain("Kept, dated: you said still broken on 2026-09-14.");
  expect(reply).toContain('"water still comes through"');
  expect(reply).toContain("You now follow this building");
});

test("a violation the person was never asked about is not recorded; they are asked which one", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  const inboxId = await incoming(t, "<m2@test>");

  const out = await t.mutation(internal.inbound.agentRecordAnswer, { inboxId, violationId: "99999999", answer: "fixed", note: null });
  expect(out).toContain("not a violation this person was asked about");
  const reply = await lastReply(t);
  expect(reply).toContain("Which repair do you mean?");
  expect(reply).toContain(`#${VIOLATION}`);
  const answered = await t.run(async (ctx) => (await ctx.db.query("attestations").collect()).filter((r) => r.answer !== undefined));
  expect(answered).toHaveLength(0);
});

test("the ASK tool asks about the building the agent found", async () => {
  const t = make();
  await seed(t);
  const inboxId = await incoming(t, "<m1@test>");
  expect(await t.mutation(internal.inbound.agentAsk, { inboxId, bbl: BBL })).toBe("asked and replied");
  const reply = await lastReply(t);
  expect(reply).toContain("They say it's fixed. Is it?");
  expect(reply).toContain(`#${VIOLATION} at ${LABEL}`);
});

test("asking which building gives the address prompt, and unsupported says what the service covers", async () => {
  const t = make();
  await seed(t);
  const a = await incoming(t, "<m1@test>");
  await t.mutation(internal.inbound.agentClarify, { inboxId: a, what: "building" });
  expect(await lastReply(t)).toContain("Which building do you mean?");
  const b = await incoming(t, "<m2@test>");
  await t.mutation(internal.inbound.agentClarify, { inboxId: b, what: "unsupported" });
  expect(await lastReply(t)).toContain("We answer about New York City housing repairs and US layoff filings.");
});
