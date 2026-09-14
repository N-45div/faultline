/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { citySecondWord } from "../convex/ingest/write";

// The tenant loop, end to end, against an in-memory Convex: a person asks
// about a building, answers, and — when the city later stamps the owner's
// certification false — is told, while the building's public page shows their
// word only from that moment, and never the words themselves. Mail leaves
// through the real send path; only the network is replaced.

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => convexTest(schema, modules);
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
  // The keyword path. The agent path has its own tests.
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
