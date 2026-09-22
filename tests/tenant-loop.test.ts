/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import { cancel, list } from "@convex-dev/workflow";
import { api, components, internal } from "../convex/_generated/api";
import { citySecondWord } from "../convex/ingest/write";
import { callFlow } from "../convex/callFlow";

// The tenant loop, end to end, against an in-memory Convex: a person asks
// about a building, answers, and — when the city later stamps the owner's
// certification false — is told, while the building's public page shows their
// word only from that moment, and never the words themselves. Mail leaves
// through the real send path; only the network is replaced.

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  // The workflow a call finishes in (convex/callFlow.ts), and the workpool it runs on.
  workflowTest.register(t);
  return t;
};
type T = ReturnType<typeof make>;

// convex-test waits a bounded number of turns for a scheduled function to
// finish, and a call's first workflow step loads the workflow's modules. Loaded
// cold, they sometimes took longer than that; they are loaded here first.
beforeAll(async () => {
  const all = [modules, workflowTest.modules, workpoolTest.modules].flatMap((m) => Object.entries(m));
  await Promise.all(all.filter(([path]) => !/convex\.config|\.test\./.test(path)).map(([, load]) => load()));
});

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
const calle: { placed: any[]; result: any; reads: number; failReads: number } = { placed: [], result: null, reads: 0, failReads: 0 };
// GPT-6 Astra reading a call a second time, stood in for at the Responses API:
// it fails as many times as a test says, then reports what the test says.
const model: { runs: number; failures: number; report: unknown } = { runs: 0, failures: 0, report: null };
let labelled: { url: string; add: string[]; remove: string[] }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  vi.stubEnv("AGENTMAIL_INBOX_ID", "getnotice@agentmail.to");
  vi.stubEnv("AGENTMAIL_API_KEY", "test-key");
  vi.stubEnv("CONVEX_SITE_URL", "https://faultline.test");
  vi.stubEnv("NOTICE_POSTAL", "1 Test Street, New York, NY 10001");
  // The keyword path. The agent path has its own tests.
  vi.stubEnv("OPENAI_API_KEY", "");
  sent = [];
  calle.placed = [];
  calle.result = null;
  calle.reads = 0;
  calle.failReads = 0;
  model.runs = 0;
  model.failures = 0;
  model.report = null;
  labelled = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // CALL-E, stood in for: a call is "placed" by being written down, and read
    // back as whatever the test says happened on it.
    if (String(url).includes("heycall-e.com")) {
      if (init?.method === "POST") {
        calle.placed.push(body);
        return new Response(JSON.stringify({ id: "call_test_1", object: "call_task", status: "queued" }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      calle.reads += 1;
      if (calle.failReads > 0) {
        calle.failReads -= 1;
        return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(calle.result), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // A failure is a 500 the OpenAI SDK is told not to retry itself, so the retry under test is ours.
    if (String(url).includes("api.openai.com")) {
      model.runs += 1;
      if (model.failures > 0) {
        model.failures -= 1;
        return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 500, headers: { "Content-Type": "application/json", "x-should-retry": "false" } });
      }
      const report = { type: "function_call", id: "fc_1", call_id: "call_1", name: "report_call", arguments: JSON.stringify(model.report), status: "completed" };
      const usage = { input_tokens: 400, output_tokens: 40, total_tokens: 440, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
      return new Response(JSON.stringify({ id: `resp_${model.runs}`, object: "response", created_at: 0, status: "completed", model: "gpt-6-astra", output: [report], usage }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Labelling a message is a PATCH to the same inbox; it is not a send, and
    // must not be mistaken for the reply a test is reading.
    if (Array.isArray(body.add_labels)) labelled.push({ url: String(url), add: body.add_labels, remove: body.remove_labels ?? [] });
    else sent.push({ url: String(url), body });
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

async function seed(t: T, status = "NOV CERTIFIED ON TIME") {
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
    const fields = { ...FIELDS, currentstatus: status };
    const identityKey = `${BBL}/${VIOLATION}`;
    const observationId = await ctx.db.insert("observations", {
      sourceId,
      snapshotId,
      identityKey,
      subjectKey: BBL,
      claimKind: "hpd.violation_status",
      assertedAt: "2026-09-10",
      capturedAt: Date.now(),
      fields,
      sigHash: "s",
      fullHash: "f",
    });
    await ctx.db.insert("current", { sourceId, identityKey, subjectKey: BBL, observationId, sigHash: "s", fullHash: "f", fields, updatedAt: Date.now() });
    // The thread this person already has with us about the building.
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

/** One email from the tenant, handled, with whatever it sends back. */
async function receive(t: T, id: string, subject: string, text: string): Promise<string> {
  const message = { message_id: id, thread_id: "thread-1", inbox_id: "getnotice@agentmail.to", from: `A Tenant <${TENANT}>`, subject, text };
  const before = sent.length;
  await t.mutation(internal.inbound.onMessageReceived, { message, thread: {}, eventId: id });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return sent.length > before ? (sent[sent.length - 1].body.text ?? "") : "";
}

/** The city's file moves the violation to a new status; the digest runs. */
async function cityStamps(t: T, status: string, on: string) {
  await t.run(async (ctx) => {
    await citySecondWord(ctx, [{ subjectKey: BBL, kind: "changed", after: { ...FIELDS, currentstatus: status, currentstatusdate: on } }], "https://city.test/file");
  });
  await t.mutation(internal.digest.flush, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

test("asked, answered, and told when the city agrees; the public page shows the word only then, and never the note", async () => {
  const t = make();
  await seed(t);

  const ask = await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  expect(ask).toContain("They say it's fixed. Is it?");
  expect(ask).toContain(`#${VIOLATION} at ${LABEL}`);
  expect(ask).toContain("HPD's 70 days run to 2026-11-19");
  const token = /https:\/\/faultline\.test\/r\/([0-9a-f]{40})/.exec(ask)?.[1];
  expect(token).toBeDefined();

  const answer = await receive(
    t,
    "<m2@test>",
    `Re: ${LABEL}`,
    `#${VIOLATION} STILL BROKEN - the notice was never posted\n\nOn Mon, Sep 14, 2026 at 12:01 PM Faultline <getnotice@agentmail.to> wrote:\n> They say it's fixed. Is it?`,
  );
  expect(answer).toContain("Kept, dated: you said still broken on 2026-09-14.");
  expect(answer).toContain("may challenge the certification");
  expect(answer).toContain("You now follow this building");
  expect(answer).toContain(`https://faultline.test/r/${token}`);

  const mine = await t.query(api.attest.record, { token: token! });
  expect(mine?.items.find((i) => i.answer)?.note).toBe("the notice was never posted");
  expect((await t.query(api.attest.corroborated, { bbl: BBL })).rows).toEqual([]);

  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  const before = sent.length;
  await cityStamps(t, "FALSE CERTIFICATION", "2026-09-21");
  expect(sent.length).toBe(before + 1);
  const payoff = sent[sent.length - 1];
  expect(payoff.url).toContain(encodeURIComponent("<m2@test>"));
  expect(payoff.body.text).toContain("The city checked a repair you told us about.");
  expect(payoff.body.text).toContain(
    `The city agrees with you: HPD stamped #${VIOLATION} at ${LABEL} FALSE CERTIFICATION on 2026-09-21. You said still broken on 2026-09-14`,
  );
  expect(payoff.body.text).toContain(`https://faultline.test/r/${token}`);

  const shown = await t.query(api.attest.corroborated, { bbl: BBL });
  expect(shown.rows).toHaveLength(1);
  expect(shown.rows[0]).toMatchObject({ violationId: VIOLATION, saidOn: "2026-09-14", laterStatus: "FALSE CERTIFICATION", laterStatusDate: "2026-09-21" });
  expect(JSON.stringify(shown)).not.toContain("never posted");
});

test("a second answer is a second dated word, and the city's word goes to the one that said still broken", async () => {
  const t = make();
  await seed(t);
  const ask = await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  const token = /\/r\/([0-9a-f]{40})/.exec(ask)![1];

  await receive(t, "<m2@test>", `Re: ${LABEL}`, `#${VIOLATION} not sure, haven't been downstairs`);
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
  const second = await receive(t, "<m3@test>", `Re: ${LABEL}`, `#${VIOLATION} still broken`);
  expect(second).toContain("Kept, dated: you said still broken on 2026-09-16.");

  const mine = await t.query(api.attest.record, { token });
  expect(mine!.items.filter((i) => i.answer).map((i) => i.answer).sort()).toEqual(["not_sure", "still_broken"]);

  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  await cityStamps(t, "INVALID CERTIFICATION", "2026-09-21");
  const payoffs = sent.filter((s) => s.body.text?.includes("The city checked"));
  expect(payoffs).toHaveLength(1);
  expect(payoffs[0].body.text).toContain("You said still broken on 2026-09-16");
});

test("after STOP, the city's word is kept on the record and nobody is emailed", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `#${VIOLATION} STILL BROKEN`);
  const stopped = await receive(t, "<m3@test>", "STOP", "");
  expect(stopped).toContain("Stopped.");

  const before = sent.length;
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  await cityStamps(t, "FALSE CERTIFICATION", "2026-09-21");
  expect(sent.length).toBe(before);
  expect((await t.query(api.attest.corroborated, { bbl: BBL })).rows).toHaveLength(1);
});

test("ASK where no certification is inside its 70 days says so, and asks nothing", async () => {
  const t = make();
  await seed(t, "VIOLATION CLOSED");
  const reply = await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  expect(reply).toContain(`No repair at ${LABEL} is certified as done right now`);
  const rows = await t.run((ctx) => ctx.db.query("attestations").collect());
  expect(rows).toHaveLength(0);
});

/** AgentMail's own word about what happened to a message we sent. */
async function mailEvent(t: T, event_type: string, outboundId: string) {
  await t.mutation(internal.inbound.onMailEvent, {
    event: { event_type, message: { message_id: outboundId, to: [TENANT] } },
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function lastOutboundId(t: T): Promise<string> {
  const r = await t.run((ctx) => ctx.db.query("receipts").order("desc").first());
  return r?.outboundId ?? "";
}

test("a spam complaint is final: the follows go off and nothing is sent again", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `#${VIOLATION} STILL BROKEN`);
  expect((await t.run((ctx) => ctx.db.query("subscriptions").collect())).some((s) => s.active)).toBe(true);

  await mailEvent(t, "message.complained", await lastOutboundId(t));
  expect((await t.run((ctx) => ctx.db.query("subscriptions").collect())).every((s) => !s.active)).toBe(true);

  // They write again; the message is kept, and still nothing goes back.
  const before = sent.length;
  expect(await receive(t, "<m3@test>", `Re: ${LABEL}`, "ASK")).toBe("");
  expect(sent.length).toBe(before);
  expect(await t.run((ctx) => ctx.db.query("inbox").order("desc").first())).toMatchObject({ replied: false });

  // And the city's later word reaches nobody.
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  await cityStamps(t, "FALSE CERTIFICATION", "2026-09-21");
  expect(sent.length).toBe(before);
});

test("a bounce stops the mail, and clears when that address writes to us", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await mailEvent(t, "message.bounced", await lastOutboundId(t));
  expect(await t.run((ctx) => ctx.db.query("suppressions").first())).toMatchObject({ reason: "bounced" });

  // Mail arriving from that address is proof the mailbox works.
  expect(await receive(t, "<m2@test>", `Re: ${LABEL}`, "ASK")).toContain(LABEL);
  expect(await t.run((ctx) => ctx.db.query("suppressions").first())).toBe(null);
});

/** A second repair on the same building, open and unanswered. */
async function secondAsk(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert("attestations", {
      email: TENANT,
      subjectKey: BBL,
      violationId: "19115547",
      askedAt: Date.now() - 30_000,
      askedStatus: "NOV CERTIFIED ON TIME",
      askedStatusDate: "2026-09-12",
      certifiedBy: null,
      hazardClass: "B",
      description: "PROPERLY REPAIR OR REPLACE THE BROKEN LATCH SET AT DOOR AT COMPACTOR CLOSET",
    });
  });
}

test("with two repairs open and no number given, nothing is recorded on a guess", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await secondAsk(t);

  // No number, and the words alone. Without a way to tell which repair they
  // mean - here there is no key, so no embedding - they are asked.
  const reply = await receive(t, "<m2@test>", `Re: ${LABEL}`, "still broken");
  expect(reply).toContain("Which repair do you mean?");
  expect(reply).toContain("#19115547");
  const answered = await t.run((ctx) => ctx.db.query("attestations").collect());
  expect(answered.every((a) => a.answer === undefined)).toBe(true);
});

test("one repair open and no number given is still answered without asking", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  const reply = await receive(t, "<m2@test>", `Re: ${LABEL}`, "still broken");
  expect(reply).toContain("Kept, dated: you said still broken");
  const answered = await t.run((ctx) => ctx.db.query("attestations").collect());
  expect(answered.some((a) => a.answer === "still_broken")).toBe(true);
});

test("asking about a building we had stopped watching starts watching it again", async () => {
  const t = make();
  await seed(t);
  await t.run(async (ctx) => {
    const hpd = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-hpd")).unique();
    await ctx.db.insert("targets", { sourceId: hpd!._id, subjectKey: BBL, active: false, addedBy: "standing" });
  });
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  const target = await t.run((ctx) => ctx.db.query("targets").first());
  // Someone is waiting on this building's record now; the city's second word
  // about it has to reach us.
  expect(target?.active).toBe(true);
});

// ---------------------------------------------------------------- the browser trial
const SESSION = "a".repeat(32);
let said = 0;
async function type(t: T, text: string, session = SESSION) {
  const out = await t.mutation(api.web.say, { session, id: (++said).toString(16).padStart(8, "0"), text });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return out;
}
const lastShown = async (t: T, session = SESSION) => (await t.query(api.web.thread, { session })).filter((m) => m.who === "faultline").at(-1)?.text ?? "";

test("the browser trial asks and answers through the same handler, and nothing is mailed", async () => {
  const t = make();
  await seed(t);
  const before = sent.length;

  expect(await type(t, `ASK ${LABEL}`)).toEqual({ ok: true, why: "" });
  const asked = await lastShown(t);
  expect(asked).toContain("They say it's fixed. Is it?");
  expect(asked).toContain(`#${VIOLATION}`);
  // A postal address and STOP belong on mail; nothing here is mail.
  expect(asked).not.toContain("1 Test Street");
  expect(asked).not.toContain("Reply STOP");

  await type(t, `#${VIOLATION} STILL BROKEN`);
  const kept = await lastShown(t);
  expect(kept).toContain("Kept, dated: you said still broken");
  expect(kept).toContain("it shows on your trial page");
  expect(kept).not.toContain("You now follow this building");

  // How each of their messages was read travels with the thread.
  const mine = (await t.query(api.web.thread, { session: SESSION })).filter((m) => m.who === "you");
  expect(mine.map((m) => m.read)).toEqual(["ask", "answer"]);
  expect(mine.every((m) => m.answered)).toBe(true);

  expect(sent.length).toBe(before);
  expect(await t.run((ctx) => ctx.db.query("subscriptions").collect())).toHaveLength(0);
});

test("what is said in a browser trial is never a tenant's word on a public page", async () => {
  const t = make();
  await seed(t);
  await type(t, `ASK ${LABEL}`);
  await type(t, `#${VIOLATION} STILL BROKEN`);
  const before = sent.length;

  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  await cityStamps(t, "FALSE CERTIFICATION", "2026-09-21");

  // The city agreed, and the trial's own page will show it - but the public
  // page counts tenants, and anyone can open a trial.
  const pub = await t.query(api.attest.corroborated, { bbl: BBL });
  expect(pub.kept).toBe(0);
  expect(pub.rows).toHaveLength(0);
  expect(sent.length).toBe(before);
  const mine = await t.run((ctx) => ctx.db.query("attestations").collect());
  expect(mine.some((a) => a.laterStatus === "FALSE CERTIFICATION")).toBe(true);
});

test("a browser trial says what needs a mailbox, and keeps to its own room", async () => {
  const t = make();
  await seed(t);
  await type(t, `ASK ${LABEL}`);
  await type(t, "FOLLOW");
  expect(await lastShown(t)).toContain("works by email");
  await type(t, `PACK ${LABEL}`);
  expect(await lastShown(t)).toContain("The evidence pack works by email");

  // A key that is not one opens nothing and stores nothing.
  expect((await t.mutation(api.web.say, { session: "not-a-session", id: "00000001", text: "ASK" })).ok).toBe(false);
  expect(await t.query(api.web.thread, { session: "not-a-session" })).toEqual([]);

  // Twenty-five messages a day for one browser; the next is refused at the
  // door, before anything is stored.
  const other = "b".repeat(32);
  for (let i = 0; i < 25; i++) expect((await type(t, "Spirit Airlines", other)).ok).toBe(true);
  const stored = (await t.run((ctx) => ctx.db.query("inbox").collect())).length;
  const refused = await type(t, "Spirit Airlines", other);
  expect(refused.ok).toBe(false);
  expect(refused.why).toContain("By email there is more room");
  expect((await t.run((ctx) => ctx.db.query("inbox").collect())).length).toBe(stored);
});

test("the landing's reply card is one row, and ASK about that building answers from it", async () => {
  const t = make();
  await seed(t);
  expect(await t.query(api.wall.sampleAsk, {})).toBe(null);
  expect(await t.mutation(internal.wall.refreshSampleAsk, {})).toBe(1);
  const card = await t.query(api.wall.sampleAsk, {});
  expect(card?.label).toBe(LABEL);
  expect(card?.stamps.map((s) => s.violationId)).toEqual([VIOLATION]);

  // The rows themselves could now be anything; the reply is built from the card.
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("current").collect()) await ctx.db.delete(row._id);
  });
  expect(await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK")).toContain(`#${VIOLATION}`);
});

test("a commit keeps its own tally, and the file's log reads it instead of the change rows", async () => {
  const t = make();
  await seed(t);
  const { sourceId, snapshotId } = await t.run(async (ctx) => {
    const src = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", "nyc-hpd")).unique();
    const snap = await ctx.db.insert("snapshots", { sourceId: src!._id, capturedAt: Date.now(), requestUrl: "https://city.test/file", httpStatus: 200, bodySha256: "1".repeat(64), rowCount: 3, degraded: false });
    return { sourceId: src!._id, snapshotId: snap };
  });
  const change = (kind: "added" | "changed" | "removed", id: string) => ({ identityKey: `${BBL}/${id}`, subjectKey: BBL, kind, changed: ["currentstatus"], after: { ...FIELDS, violationid: id }, sentence: `A violation at ${LABEL} moved.` });
  // A commit arrives in slices; the tally adds up across them.
  await t.mutation(internal.ingest.write.commitBatch, { sourceId, snapshotId, capturedAt: Date.now(), observations: [], changes: [change("added", "1"), change("changed", "2")], sourceUrl: "https://city.test/file" });
  await t.mutation(internal.ingest.write.commitBatch, { sourceId, snapshotId, capturedAt: Date.now(), observations: [], changes: [change("changed", "3")], sourceUrl: "https://city.test/file" });
  expect(await t.run((ctx) => ctx.db.get(snapshotId))).toMatchObject({ added: 1, changed: 2, removed: 0 });

  // The rows behind it could be gone; the log still says what the commit did.
  await t.run(async (ctx) => {
    for (const c of await ctx.db.query("changes").collect()) await ctx.db.delete(c._id);
  });
  const log = await t.query(api.files.log, { slug: "nyc-hpd" });
  const first = log?.commits.find((c) => c.kind === "commit");
  expect(first).toMatchObject({ added: 1, changed: 2, removed: 0, more: false });
});

test("by voice: the message says how it was heard, a reply is read only to its own browser, and voice has its own room", async () => {
  const t = make();
  await seed(t);
  await type(t, `ASK ${LABEL}`);
  // What the transcriber wrote down goes through the same door as typing.
  const heard = await t.mutation(internal.web.sayHeard, { session: SESSION, id: "0000beef", text: `#${VIOLATION} STILL BROKEN`, heardBy: "gpt-4o-mini-transcribe" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(heard.ok).toBe(true);
  const thread = await t.query(api.web.thread, { session: SESSION });
  expect(thread.filter((m) => m.who === "you").at(-1)).toMatchObject({ heard: "gpt-4o-mini-transcribe", read: "answer", answered: true });

  // Read aloud: only a reply in this browser's thread, and as the tool wrote it, made sayable.
  const reply = thread.filter((m) => m.who === "faultline").at(-1)!;
  const spoken = await t.query(internal.web.spokenReply, { session: SESSION, replyId: reply.id });
  expect(spoken).toContain("Kept, dated: you said still broken");
  expect(spoken).toContain(`violation ending ${VIOLATION.slice(-4).split("").join(" ")}`);
  expect(spoken).not.toMatch(/https?:/);
  expect(await t.query(internal.web.spokenReply, { session: "c".repeat(32), replyId: reply.id })).toBe(null);
  expect(await t.query(internal.web.spokenReply, { session: SESSION, replyId: "not-an-id" })).toBe(null);

  // Fifteen recordings a day for one browser, charged before any model hears them.
  for (let i = 0; i < 15; i++) expect((await t.mutation(internal.web.allowVoice, { session: SESSION, what: "hear" })).ok).toBe(true);
  expect((await t.mutation(internal.web.allowVoice, { session: SESSION, what: "hear" })).ok).toBe(false);
  expect((await t.mutation(internal.web.allowVoice, { session: SESSION, what: "speak" })).ok).toBe(true);
});

test("as a conversation: words are taken only while a conversation our server started is open, and it is priced by the clock", async () => {
  const t = make();
  await seed(t);
  // No conversation is open for this browser, so the page cannot claim its words came from one.
  expect((await t.mutation(api.web.say, { session: SESSION, id: "0000a001", text: `Ask about ${LABEL}.`, live: true })).ok).toBe(false);
  expect(await t.query(api.web.thread, { session: SESSION })).toEqual([]);

  // Our server starts one (POST /voice/live ends here), and gives it its end.
  await t.mutation(internal.web.liveStarted, { session: SESSION, liveId: "live_test_1" });
  // "Ask about <address>." as a transcriber writes it becomes the command, and is read with no model.
  const out = await t.mutation(api.web.say, { session: SESSION, id: "0000a002", text: `Ask about ${LABEL}.`, live: true });
  expect(out).toEqual({ ok: true, why: "" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await lastShown(t)).toContain("They say it's fixed. Is it?");
  const mine = (await t.query(api.web.thread, { session: SESSION })).filter((m) => m.who === "you");
  expect(mine.at(-1)).toMatchObject({ heard: "gpt-live-1", read: "ask", answered: true });

  // The page says how long it ran. It is believed only up to what the clock allows, and priced.
  await t.mutation(api.web.liveEnded, { session: SESSION, liveId: "live_test_1", seconds: 99_999 });
  const row = await t.run((ctx) => ctx.db.query("liveSessions").first());
  expect(row?.endedBy).toBe("the page");
  expect(row?.seconds).toBeLessThanOrEqual(180);
  const priced = (await t.run((ctx) => ctx.db.query("llmUsage").collect())).filter((u) => u.purpose === "live");
  expect(priced).toHaveLength(1);
  expect(priced[0]).toMatchObject({ model: "gpt-live-1" });
  // Ended twice is ended once; and an ended conversation takes no more words.
  await t.mutation(api.web.liveEnded, { session: SESSION, liveId: "live_test_1", seconds: 5 });
  expect((await t.run((ctx) => ctx.db.query("llmUsage").collect())).filter((u) => u.purpose === "live")).toHaveLength(1);
  expect((await t.mutation(api.web.say, { session: SESSION, id: "0000a003", text: "hello", live: true })).ok).toBe(false);
  // It is in the thread as what it was: a conversation, so many seconds long.
  expect((await t.query(api.web.thread, { session: SESSION })).find((m) => m.who === "live")).toMatchObject({ seconds: row?.seconds });

  // Three conversations a day for one browser, charged before any model is called.
  for (let i = 0; i < 3; i++) expect((await t.mutation(internal.web.allowVoice, { session: SESSION, what: "live" })).ok).toBe(true);
  expect((await t.mutation(internal.web.allowVoice, { session: SESSION, what: "live" })).ok).toBe(false);
});

// ---------------------------------------------------------------- CALL ME
const NUMBER = "+1 718 555 0142";

/**
 * A call test, run twice: with NOTICE_CALL_FLOW unset, where what happens
 * after the call hangs up is the scheduled functions it always was, and set to
 * "workflow", where it is a workflow (convex/callFlow.ts).
 */
function callTest(name: string, fn: (flow: "workflow" | "direct") => Promise<void>) {
  for (const flow of ["direct", "workflow"] as const) {
    test(flow === "direct" ? name : `${name} (NOTICE_CALL_FLOW=workflow)`, async () => {
      vi.stubEnv("NOTICE_CALL_FLOW", flow === "direct" ? undefined : flow);
      await fn(flow);
    });
  }
}
const finished = (structured: unknown, turns: { speaker: string; text: string }[] = [{ speaker: "bot", text: "Is it fixed?" }, { speaker: "user", text: "No. Nobody came, it's the same." }]) => ({
  id: "call_test_1",
  status: "completed",
  structured_result: structured,
  recipients: [{ attempts: [{ transcript_turns: turns.map((t, i) => ({ offset_seconds: i * 4, ...t })) }] }],
});

callTest("CALL ME rings the number they wrote, and what they say on the call is recorded like a written answer", async (flow) => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  const told = await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  expect(told).toContain("Calling the number ending 0142 now.");
  expect(told).toContain("automated call");

  // What CALL-E was given: the number, the city's words made sayable, and the only answers it may return.
  expect(calle.placed).toHaveLength(1);
  const placed = calle.placed[0];
  expect(placed.recipients[0]).toMatchObject({ phones: ["+17185550142"], region: "US" });
  expect(placed.task).toContain("This is an automated call from Faultline");
  expect(placed.task).toContain(`violation ${VIOLATION}`);
  expect(placed.result_schema.properties.answers.items.properties.violation.enum).toEqual([VIOLATION]);
  expect(placed.webhook_url).toBe("https://faultline.test/hooks/calle");
  // The number is not in our tables: a hash, and four digits.
  const row = await t.run((ctx) => ctx.db.query("calls").first());
  expect(row).toMatchObject({ tail: "0142", status: "ringing", callId: "call_test_1", asked: [VIOLATION] });
  // The path it finishes on is kept on the row as it is placed.
  expect(row?.workflowId !== undefined).toBe(flow === "workflow");
  expect(JSON.stringify(row)).not.toContain("7185550142");

  // The call ends. One answer about the repair we asked about, one about a repair nobody asked about.
  calle.result = finished({
    reached: "yes",
    asked_for_this_call: "yes",
    answers: [
      { violation: VIOLATION, answer: "still_broken", their_words: "nobody came, it is the same" },
      { violation: "99999999", answer: "fixed", their_words: "made up" },
    ],
  });
  const before = sent.length;
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const receipt = sent.at(-1)?.body.text ?? "";
  expect(sent.length).toBe(before + 1);
  expect(receipt).toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(receipt).toContain('"nobody came, it is the same"');
  const kept = await t.run((ctx) => ctx.db.query("attestations").collect());
  expect(kept.filter((a) => a.answer === "still_broken")).toHaveLength(1);
  expect(kept.some((a) => a.violationId === "99999999")).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("calls").first())).toMatchObject({ status: "completed", answered: 1 });

  // Read back twice, recorded once.
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.length).toBe(before + 1);
});

callTest("no number, nothing to ask, or a number that said no: no telephone rings", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  await seed(t);
  // Before anything has been asked, there is nothing to ring about.
  // (seed() has already taken <m0@test>; a second message with that id is a duplicate and gets no reply.)
  expect(await receive(t, "<m-call0@test>", "CALL ME", `CALL ME ${NUMBER}`)).toContain("There is nothing to ask you about yet.");
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  expect(await receive(t, "<m2@test>", `Re: ${LABEL}`, "CALL ME")).toContain("Which number should we ring?");
  expect(calle.placed).toHaveLength(0);

  // They are rung; the person who answers says they never asked for it.
  await receive(t, "<m3@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  expect(calle.placed).toHaveLength(1);
  calle.result = finished({ reached: "yes", asked_for_this_call: "no", answers: [{ violation: VIOLATION, answer: "fixed", their_words: "" }] });
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.at(-1)?.body.text ?? "").toContain("said they hadn't asked for the call");
  // Nothing they said is recorded, and that number is never rung again.
  expect((await t.run((ctx) => ctx.db.query("attestations").collect())).every((a) => a.answer === undefined)).toBe(true);
  expect(await receive(t, "<m4@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`)).toContain("asked us not to call it");
  expect(calle.placed).toHaveLength(1);
});

callTest("a quote is kept only if the transcript has them saying it", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  // The answer is theirs. The sentence is not: nobody on the call said it.
  calle.result = finished({ reached: "yes", asked_for_this_call: "yes", answers: [{ violation: VIOLATION, answer: "still_broken", their_words: "the landlord is a criminal and should be jailed" }] });
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const receipt = sent.at(-1)?.body.text ?? "";
  expect(receipt).toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(receipt).not.toContain("criminal");
  const kept = await t.run((ctx) => ctx.db.query("attestations").collect());
  expect(kept.filter((a) => a.answer === "still_broken")).toHaveLength(1);
  expect(JSON.stringify(kept)).not.toContain("criminal");
  expect(await t.run((ctx) => ctx.db.query("calls").first())).toMatchObject({ status: "completed", readBy: "CALL-E" });
});

callTest("with a model to ask, a call is read twice, and only what both readers agree on is recorded", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  const callRow = (await t.run((ctx) => ctx.db.query("calls").first()))!._id;
  const turns = [
    { who: "call", text: "Is it fixed?" },
    { who: "you", text: "No. Nobody came, it's the same." },
  ];
  const heard = [{ violationId: VIOLATION, answer: "still_broken" as const, words: "Nobody came, it's the same" }];

  // CALL-E has reported. With a key, nothing is recorded yet: the call waits for its second reader.
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  const before = sent.length;
  await t.mutation(internal.inbound.callFinished, { callRow, status: "completed", answers: heard, declined: false, reached: true, turns, why: "" });
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "reading", heard, turns });
  expect(sent.length).toBe(before);
  expect((await t.run((ctx) => ctx.db.query("attestations").collect())).every((a) => a.answer === undefined)).toBe(true);
  // What the second reader is handed says what each number is, and not what CALL-E made of the call.
  const given = await t.query(internal.calls.forReading, { callRow });
  expect(given?.questions[0]).toMatchObject({ violationId: VIOLATION });
  // A webhook that arrives twice does not start a second reading, or finish the call early.
  await t.mutation(internal.inbound.callFinished, { callRow, status: "completed", answers: heard, declined: false, reached: true, turns, why: "" });
  expect(sent.length).toBe(before);

  // GPT-6 Astra read it the same way: recorded once, and the receipt says two readers agreed.
  // (The model is stood in for: callRead is what its reading ends in. The reading that was scheduled finds the call settled and does nothing.)
  await t.mutation(internal.inbound.callRead, { callRow, answers: heard, unsure: [], declined: false, readBy: "CALL-E and GPT-6 Astra", cents: 0.9 });
  vi.stubEnv("OPENAI_API_KEY", "");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const receipt = sent.at(-1)?.body.text ?? "";
  expect(sent.length).toBe(before + 1);
  expect(receipt).toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(receipt).toContain("Two readers went over the call separately and read your answer the same way");
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "completed", answered: 1, readBy: "CALL-E and GPT-6 Astra", readCents: 0.9 });
  // Read back again after it is settled: nothing more is sent or recorded.
  await t.mutation(internal.inbound.callRead, { callRow, answers: heard, unsure: [], declined: false, readBy: "CALL-E and GPT-6 Astra" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.length).toBe(before + 1);
});

callTest("two readers who disagree record nothing, and the person is asked again in writing", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  const callRow = (await t.run((ctx) => ctx.db.query("calls").first()))!._id;
  await t.run((ctx) => ctx.db.patch(callRow, { status: "reading", readingAt: Date.now(), turns: [{ who: "you", text: "well, sort of" }] }));
  await t.mutation(internal.inbound.callRead, { callRow, answers: [], unsure: [VIOLATION], declined: false, readBy: "CALL-E and GPT-6 Astra" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const told = sent.at(-1)?.body.text ?? "";
  expect(told).toContain(`We weren't sure what you said on the call about #${VIOLATION}.`);
  expect(told).toContain("nothing was recorded for it");
  expect((await t.run((ctx) => ctx.db.query("attestations").collect())).every((a) => a.answer === undefined)).toBe(true);
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "completed", answered: 0, unsure: [VIOLATION] });
});

callTest("a second reading that never comes back is not waited for", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  const callRow = (await t.run((ctx) => ctx.db.query("calls").first()))!._id;
  const turns = [{ who: "you", text: "yes it is fixed now" }];
  const heard = [{ violationId: VIOLATION, answer: "fixed" as const, words: "it is fixed now" }];
  await t.run((ctx) => ctx.db.patch(callRow, { status: "reading", readingAt: Date.now() - 10 * 60_000, turns, heard }));
  await t.mutation(internal.inbound.callFinished, { callRow, status: "completed", answers: heard, declined: false, reached: true, turns, why: "" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.at(-1)?.body.text ?? "").toContain(`On the call you said fixed, about #${VIOLATION}.`);
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "completed", answered: 1, readBy: "CALL-E" });
});


// ---------------------------------------------------------------- after the call hangs up: the workflow
// Each call here is placed with NOTICE_CALL_FLOW=workflow: unset, a call finishes the direct way.
const workflows = (t: T) => t.run(async (ctx) => (await list(ctx, components.workflow)).page);
const hook = (t: T) =>
  t.fetch("/hooks/calle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "call.completed", data: { id: "call_test_1" } }) });
const stillBroken = () =>
  finished({ reached: "yes", asked_for_this_call: "yes", answers: [{ violation: VIOLATION, answer: "still_broken", their_words: "nobody came, it is the same" }] });
const agrees = { asked_for_this_call: "yes", answers: [{ violation: VIOLATION, answer: "still_broken", their_words: "Nobody came, it's the same" }] };

test("only NOTICE_CALL_FLOW=workflow, in any case, switches the workflow on; any other value is said in the logs and places calls the direct way", () => {
  const said = vi.spyOn(console, "error").mockImplementation(() => {});
  const cases: [string | undefined, "workflow" | "direct"][] = [
    [undefined, "direct"],
    ["", "direct"],
    ["direct", "direct"],
    ["workflow", "workflow"],
    [" Workflow ", "workflow"],
    ["on", "direct"],
    ["true", "direct"],
  ];
  for (const [value, flow] of cases) {
    vi.stubEnv("NOTICE_CALL_FLOW", value);
    expect(callFlow()).toBe(flow);
  }
  expect(said.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('"on"'), expect.stringContaining('"true"')]);
  said.mockRestore();
});

test("a webhook that comes again, and the polls, start no second workflow, and the call is recorded once", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  vi.stubEnv("NOTICE_CALL_FLOW", "workflow");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  const callRow = (await t.run((ctx) => ctx.db.query("calls").first()))!._id;
  const [one] = await workflows(t);
  expect(one).toMatchObject({ name: "callFlow:afterCall" });
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ workflowId: one.workflowId });

  // Still ringing: told twice to look, and a poll. It looks each time, and waits.
  calle.result = { id: "call_test_1", status: "in_progress" };
  const before = sent.length;
  expect((await hook(t)).status).toBe(204);
  expect((await hook(t)).status).toBe(204);
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await workflows(t)).map((w) => w.workflowId)).toEqual([one.workflowId]);
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "on the call" });
  expect(sent.length).toBe(before);

  // It hangs up, and CALL-E says so twice, while a poll finds it too.
  calle.result = stillBroken();
  await hook(t);
  await hook(t);
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.length).toBe(before + 1);
  expect(sent.at(-1)?.body.text ?? "").toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect((await t.run((ctx) => ctx.db.query("attestations").collect())).filter((a) => a.answer === "still_broken")).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "completed", answered: 1, readBy: "CALL-E", workflowId: one.workflowId });
  // Its journal, with the transcript in it, is not kept once it has ended.
  expect(await workflows(t)).toEqual([]);
  expect(calle.placed).toHaveLength(1);

  // A webhook after that finds the call finished.
  await hook(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.length).toBe(before + 1);
});

test("CALL-E failing to answer when the call is read back is tried again, without waiting for the next poll", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  vi.stubEnv("NOTICE_CALL_FLOW", "workflow");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  calle.result = stillBroken();
  calle.failReads = 1;
  calle.reads = 0;
  const before = sent.length;
  // One webhook, and no poll after it.
  await hook(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(calle.reads).toBe(2);
  expect(sent.length).toBe(before + 1);
  expect(sent.at(-1)?.body.text ?? "").toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(await t.run((ctx) => ctx.db.query("calls").first())).toMatchObject({ status: "completed", answered: 1 });
});

test("the second reader failing once is tried again, and what the two readers agree on is recorded", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  vi.stubEnv("NOTICE_CALL_FLOW", "workflow");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  model.failures = 1;
  model.report = agrees;
  calle.result = stillBroken();
  const before = sent.length;
  await hook(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  // On the direct path, CALL-E's reading would have stood alone after the first failure.
  expect(model.runs).toBe(2);
  expect(sent.length).toBe(before + 1);
  const receipt = sent.at(-1)?.body.text ?? "";
  expect(receipt).toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(receipt).toContain("Two readers went over the call separately and read your answer the same way");
  expect((await t.run((ctx) => ctx.db.query("attestations").collect())).filter((a) => a.answer === "still_broken")).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("calls").first())).toMatchObject({ status: "completed", answered: 1, readBy: "CALL-E and GPT-6 Astra" });
});

test("the second reader failing every time leaves CALL-E's reading standing alone, as on the direct path", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  vi.stubEnv("NOTICE_CALL_FLOW", "workflow");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  model.failures = 10;
  calle.result = stillBroken();
  await hook(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(model.runs).toBe(2);
  expect(sent.at(-1)?.body.text ?? "").toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(await t.run((ctx) => ctx.db.query("calls").first())).toMatchObject({ status: "completed", answered: 1, readBy: "CALL-E" });
});

test("a call placed by the old code, and parked by it for a second reading, still finishes, with no workflow", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  // Placed the way every call was before the workflow; then the switch is set, or the deploy lands, while it rings.
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  vi.stubEnv("NOTICE_CALL_FLOW", "workflow");
  const callRow = (await t.run((ctx) => ctx.db.query("calls").first()))!._id;
  expect((await t.run((ctx) => ctx.db.get(callRow)))?.workflowId).toBeUndefined();

  // It hangs up. callFinished parks it and schedules its second reading, as the old code did.
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  model.report = agrees;
  calle.result = stillBroken();
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "reading" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.at(-1)?.body.text ?? "").toContain("Two readers went over the call separately and read your answer the same way");
  expect(await t.run((ctx) => ctx.db.get(callRow))).toMatchObject({ status: "completed", answered: 1, readBy: "CALL-E and GPT-6 Astra" });
  expect(await workflows(t)).toEqual([]);
});

test("a call placed with a workflow finishes in it after the switch is turned off", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  vi.stubEnv("NOTICE_CALL_FLOW", "workflow");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  expect(await workflows(t)).toHaveLength(1);
  vi.stubEnv("NOTICE_CALL_FLOW", undefined);
  calle.result = stillBroken();
  await t.action(internal.calls.reconcile, { callId: "call_test_1" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.at(-1)?.body.text ?? "").toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(await t.run((ctx) => ctx.db.query("calls").first())).toMatchObject({ status: "completed", answered: 1 });
  // It ran to its end and was deleted: the workflow finished the call.
  expect(await workflows(t)).toEqual([]);
});

test("a workflow that stops before the call ends does not lose the call: the direct path finishes it", async () => {
  const t = make();
  vi.stubEnv("CALLE_API_KEY", "test-calle");
  vi.stubEnv("NOTICE_CALL_FLOW", "workflow");
  await seed(t);
  await receive(t, "<m1@test>", `Re: ${LABEL}`, "ASK");
  await receive(t, "<m2@test>", `Re: ${LABEL}`, `CALL ME ${NUMBER}`);
  const [one] = await workflows(t);
  await t.run((ctx) => cancel(ctx, components.workflow, one.workflowId));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await workflows(t)).toEqual([]);
  calle.result = stillBroken();
  const before = sent.length;
  await hook(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(sent.length).toBe(before + 1);
  expect(sent.at(-1)?.body.text ?? "").toContain(`On the call you said still broken, about #${VIOLATION}.`);
  expect(await t.run((ctx) => ctx.db.query("calls").first())).toMatchObject({ status: "completed", answered: 1, readBy: "CALL-E" });
});
