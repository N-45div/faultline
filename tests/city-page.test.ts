/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import firecrawlTest from "@firecrawl/firecrawl-convex/test";
import { api, internal } from "../convex/_generated/api";
import { limits } from "../convex/limits";
import { sha256Hex } from "../engine/canon";
import page19105968 from "./fixtures/hpdonline-19105968.md?raw";
import pageNone from "./fixtures/hpdonline-0-results.md?raw";

// HPD Online's own page for a repair, read the moment someone answers about
// it, against an in-memory Convex with the Firecrawl component registered. The
// network is stood in for: the city's data file names the building, Firecrawl's
// scrape answers with the markdown it really returned for #19105968 on 22
// September 2026 (tests/fixtures), and the picture is a few bytes.

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  firecrawlTest.register(t);
  return t;
};
type T = ReturnType<typeof make>;

const VIOLATION = "19105968";
const BUILDING = "327072";
const BBL = "3050840061";
const TENANT = "tenant@example.com";
const LABEL = "155 LINDEN BOULEVARD, Brooklyn";
const SHOT = "https://storage.test/screenshot-1.png";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const scrapeOf = (markdown: string) =>
  json({
    success: true,
    data: {
      markdown,
      screenshot: SHOT,
      metadata: { title: "HPDOnline - Violations", sourceURL: `https://hpdonline.nyc.gov/hpdonline/building/${BUILDING}/violations`, statusCode: 200, creditsUsed: 1 },
      actions: { javascriptReturns: [{ type: "string", value: "opened search (3)" }, { type: "string", value: "typed into Search by Violation ID of 1" }, { type: "string", value: "rows 1" }] },
    },
  });

let city: string[] = [];
let scrapes: Record<string, any>[] = [];
let scraped: () => Response = () => scrapeOf(page19105968);
let picture: () => Response = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "Content-Type": "image/png" } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
  vi.stubEnv("AGENTMAIL_INBOX_ID", "getnotice@agentmail.to");
  vi.stubEnv("AGENTMAIL_API_KEY", "test-key");
  vi.stubEnv("CONVEX_SITE_URL", "https://faultline.test");
  vi.stubEnv("NOTICE_POSTAL", "1 Test Street, New York, NY 10001");
  vi.stubEnv("OPENAI_API_KEY", "");
  city = [];
  scrapes = [];
  scraped = () => scrapeOf(page19105968);
  picture = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "Content-Type": "image/png" } });
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://data.cityofnewyork.us/")) {
      city.push(u);
      return json([{ buildingid: BUILDING }]);
    }
    if (u === "https://api.firecrawl.dev/v2/scrape") {
      scrapes.push(JSON.parse(String(init?.body)));
      return scraped();
    }
    if (u === SHOT) return picture();
    // The reply to the tenant, and its labels: accepted, and not what these tests read.
    if (u.startsWith("https://api.agentmail.to/")) return json({ message_id: "<out@test>", thread_id: "thread-1" });
    throw new Error(`nothing else should be fetched: ${u}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const rows = (t: T) => t.run((ctx) => ctx.db.query("cityPages").collect());
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

/** A certified repair at the sample building, and the thread the tenant already has with us about it (as in tenant-loop.test.ts). */
async function seed(t: T) {
  await t.run(async (ctx) => {
    const sourceId = await ctx.db.insert("sources", { slug: "nyc-hpd", adapterVersion: 1, status: "active", emit: true, nextRunAt: 0, consecutiveFailures: 0, shadowCycles: 0 });
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
    const fields = {
      violationid: VIOLATION,
      bbl: BBL,
      class: "C",
      currentstatus: "NOV CERTIFIED ON TIME",
      currentstatusdate: "2026-09-10",
      certifiedbydate: "2026-09-10",
      novdescription: "ABATE THE INFESTATION CONSISTING OF ROACHES AT COMPACTOR CLOSET, 3RD STORY",
      __subjectKind: "building",
      __subjectKey: BBL,
      __subjectLabel: LABEL,
    };
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

async function receive(t: T, id: string, text: string) {
  const message = { message_id: id, thread_id: "thread-1", inbox_id: "getnotice@agentmail.to", from: `A Tenant <${TENANT}>`, subject: `Re: ${LABEL}`, text };
  await t.mutation(internal.inbound.onMessageReceived, { message, thread: {}, eventId: id });
  await settle(t);
}

test("an answer opens HPD Online once: a second answer inside six hours is shown the same reading, and nothing is spent", async () => {
  const t = make();
  await seed(t);
  await receive(t, "<m1@test>", "ASK");
  expect(scrapes).toHaveLength(0);

  await receive(t, "<m2@test>", `#${VIOLATION} STILL BROKEN`);
  expect(city).toHaveLength(1);
  expect(new URL(city[0]).searchParams.get("$where")).toBe(`violationid='${VIOLATION}'`);
  expect(scrapes).toHaveLength(1);
  // The building's own page, searched with the steps that worked, read afresh.
  const asked = scrapes[0];
  expect(asked.url).toBe(`https://hpdonline.nyc.gov/hpdonline/building/${BUILDING}/violations`);
  expect(asked.formats).toEqual(["markdown", { type: "screenshot", fullPage: false }]);
  expect(asked.timeout).toBe(45_000);
  expect(asked.storeInCache).toBe(false);
  expect(asked.actions.map((a: { type: string }) => a.type)).toEqual(["wait", "executeJavascript", "wait", "executeJavascript", "press", "wait", "executeJavascript", "wait"]);
  expect(JSON.stringify(asked.actions)).toContain(`i.value='${VIOLATION}'`);

  vi.setSystemTime(new Date("2026-09-14T15:00:00Z"));
  await receive(t, "<m3@test>", `#${VIOLATION} NOT SURE`);
  expect(scrapes).toHaveLength(1);
  expect(city).toHaveLength(1);

  const held = await rows(t);
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ violationId: VIOLATION, buildingId: BUILDING, outcome: "kept", statusText: "CIV10 MAILED", statusDate: "08/18/2026", certDate: "08/12/2026" });
  expect(held[0].sha256).toBe(await sha256Hex(new TextEncoder().encode(page19105968)));
  expect(held[0].changedFrom).toBeUndefined();

  const shown = await t.query(api.cityPage.forViolations, { violationIds: [VIOLATION, "12345678", "not a number"] });
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatchObject({ violationId: VIOLATION, outcome: "kept", statusText: "CIV10 MAILED", statusDate: "08/18/2026" });
  expect(shown[0].screenshotUrl).toEqual(expect.any(String));
  expect(shown[0].markdownUrl).toEqual(expect.any(String));
  // The page as Firecrawl returned it, kept whole.
  const md = await t.run(async (ctx) => (await ctx.storage.get(held[0].markdownId!))!.text());
  expect(md).toBe(page19105968);
});

test("when the day's readings are used up, the reading says so and nothing is fetched", async () => {
  const t = make();
  await t.run(async (ctx) => {
    await limits.limit(ctx, "cityPageAll", { count: 40 });
  });
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:someone" });
  await settle(t);
  expect(city).toHaveLength(0);
  expect(scrapes).toHaveLength(0);
  const held = await rows(t);
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ outcome: "capped", sha256: "", buildingId: "" });
  expect(held[0].why).toBe("HPD Online has been read as many times today as we read it in a day");
});

test("one person starts three readings a day; the fourth is capped", async () => {
  const t = make();
  for (const id of ["19105968", "19105969", "19105970", "19105971"]) {
    await t.mutation(internal.cityPage.request, { violationId: id, from: "web:one" });
  }
  await settle(t);
  expect(scrapes).toHaveLength(3);
  const held = await rows(t);
  expect(held.filter((r) => r.outcome === "capped").map((r) => r.violationId)).toEqual(["19105971"]);
});

test("a picture that fails to arrive loses the picture, not the page: the markdown and its hash are kept", async () => {
  const t = make();
  picture = () => new Response("gone", { status: 500 });
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:someone" });
  await settle(t);
  const [row] = await rows(t);
  expect(row).toMatchObject({ outcome: "kept", statusText: "CIV10 MAILED" });
  expect(row.screenshotId).toBeUndefined();
  expect(row.markdownId).toBeDefined();
  expect(row.sha256).toBe(await sha256Hex(new TextEncoder().encode(page19105968)));
  const [shown] = await t.query(api.cityPage.forViolations, { violationIds: [VIOLATION] });
  expect(shown.screenshotUrl).toBeNull();
  expect(shown.markdownUrl).toEqual(expect.any(String));
});

test("a later reading that differs says since when; one that does not, says nothing", async () => {
  const t = make();
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:a" });
  await settle(t);
  const first = (await rows(t))[0];

  vi.setSystemTime(new Date("2026-09-14T19:00:00Z"));
  scraped = () => scrapeOf(page19105968.replace("CIV10 MAILED<br>VIOLATION STATUS DATE<br>08/18/2026", "NOV CERTIFIED LATE<br>VIOLATION STATUS DATE<br>09/14/2026"));
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:b" });
  await settle(t);
  expect(scrapes).toHaveLength(2);
  const [, second] = (await rows(t)).sort((a, b) => a.capturedAt - b.capturedAt);
  expect(second).toMatchObject({ outcome: "kept", statusText: "NOV CERTIFIED LATE", statusDate: "09/14/2026", changedFrom: first.capturedAt });
  expect(second.sha256).not.toBe(first.sha256);

  vi.setSystemTime(new Date("2026-09-15T02:00:00Z"));
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:c" });
  await settle(t);
  const [shown] = await t.query(api.cityPage.forViolations, { violationIds: [VIOLATION] });
  expect(shown.statusText).toBe("NOV CERTIFIED LATE");
  expect(shown.changedFrom).toBeUndefined();
});

test("a search HPD Online answers with nothing is kept as not found, page and all", async () => {
  const t = make();
  scraped = () => scrapeOf(pageNone);
  await t.mutation(internal.cityPage.request, { violationId: "11036631", from: "web:someone" });
  await settle(t);
  const [row] = await rows(t);
  expect(row).toMatchObject({ outcome: "not_found", buildingId: BUILDING });
  expect(row.statusText).toBeUndefined();
  expect(row.markdownId).toBeDefined();
  expect(row.screenshotId).toBeDefined();
});

test("Firecrawl failing is written down as it happened, and holds off another reading for ten minutes only", async () => {
  const t = make();
  scraped = () => json({ success: false, error: "Unauthorized" }, 401);
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:someone" });
  await settle(t);
  expect(scrapes).toHaveLength(1);
  const [row] = await rows(t);
  expect(row).toMatchObject({ outcome: "failed", buildingId: BUILDING, sha256: "", why: "HPD Online could not be read" });

  vi.setSystemTime(new Date("2026-09-14T12:05:00Z"));
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:other" });
  await settle(t);
  expect(scrapes).toHaveLength(1);

  scraped = () => scrapeOf(page19105968);
  vi.setSystemTime(new Date("2026-09-14T12:20:00Z"));
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:other" });
  await settle(t);
  expect(scrapes).toHaveLength(2);
  const [shown] = await t.query(api.cityPage.forViolations, { violationIds: [VIOLATION] });
  expect(shown.outcome).toBe("kept");
});

test("no Firecrawl key, no reading: nothing is written and nothing is spent", async () => {
  const t = make();
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:someone" });
  await settle(t);
  expect(await rows(t)).toHaveLength(0);
  expect(scrapes).toHaveLength(0);
});

test("forViolations reads at most five repairs", async () => {
  const t = make();
  const ids = ["19105961", "19105962", "19105963", "19105964", "19105965", "19105966"];
  await t.run(async (ctx) => {
    for (const violationId of ids) await ctx.db.insert("cityPages", { violationId, buildingId: BUILDING, capturedAt: Date.now(), sha256: "", outcome: "reading" });
  });
  const shown = await t.query(api.cityPage.forViolations, { violationIds: ids });
  expect(shown.map((r) => r.violationId)).toEqual(ids.slice(0, 5));
});

test("every browser in use: tried once more twenty seconds later, then written down as busy", async () => {
  const t = make();
  scraped = () => json({ success: false, error: "Rate limit exceeded" }, 429);
  await t.mutation(internal.cityPage.request, { violationId: VIOLATION, from: "web:someone" });
  await settle(t);
  // The component's own short retries, then ours: two readings of four tries each.
  expect(scrapes).toHaveLength(8);
  expect(city).toHaveLength(1);
  const [row] = await rows(t);
  expect(row).toMatchObject({ outcome: "busy", buildingId: BUILDING, sha256: "", why: "Firecrawl's browsers were all in use, twice" });
});
