/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import fixture from "../data/condition-history-3050840061.json?raw";

// A repair the city cited before, against an in-memory Convex: the city's file
// for the sample building is read by an internal action, and nothing of it is
// stored; what the rule finds is kept per violation; and the page's one query
// reads only that. The city's API is stood in for by sixteen of the building's
// real rows (data/condition-history-3050840061.json).

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => convexTest(schema, modules);

const BBL = "3050840061";
const ROWS: unknown[] = JSON.parse(fixture).rows;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const theRows = () => json(ROWS);

let city: string[] = [];
let answer: () => Response = theRows;

beforeEach(() => {
  city = [];
  answer = theRows;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = String(url);
    if (!u.startsWith("https://data.cityofnewyork.us/")) throw new Error(`nothing else should be fetched: ${u}`);
    city.push(u);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const kept = (t: ReturnType<typeof make>) => t.run((ctx) => ctx.db.query("repairHistory").collect());

test("refresh reads the building's file, and keeps what the rule finds and none of the city's rows", async () => {
  const t = make();
  const out = await t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934", "19178388", "17916497"] });
  expect(out).toEqual({ read: 16, checked: 3, cited: ["19112934"] });
  expect(city).toHaveLength(1);
  // Only the columns the rule reads, for this one building, a page at a time.
  const asked = new URL(city[0]);
  expect(asked.searchParams.get("$select")).toBe("violationid,apartment,story,inspectiondate,novdescription,currentstatus,currentstatusdate,violationstatus,certifieddate");
  expect(asked.searchParams.get("$where")).toBe(`bbl='${BBL}'`);
  expect(asked.searchParams.get("$limit")).toBe("2000");
  expect(city[0]).not.toMatch(/[ ']/);

  const rows = await kept(t);
  expect(rows.map((r) => [r.violationId, r.bbl, r.rowsRead])).toEqual([
    ["19112934", BBL, 16],
    ["19178388", BBL, 16],
    ["17916497", BBL, 16],
  ]);
  expect(rows[0].earlier).toEqual([{ violationId: "18037661", inspectionDate: "2025-06-18", certifiedDate: "2025-07-31", status: "NOT COMPLIED WITH", statusDate: "2025-08-22" }]);

  // A second check reads the city again, since nothing of the first read was
  // stored, and replaces the row it kept.
  await t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] });
  expect(city).toHaveLength(2);
  expect(await kept(t)).toHaveLength(3);
});

test("forRepairs hands back what was kept, and only that: no city read, no row it was not asked for", async () => {
  const t = make();
  await t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934", "19178388"] });
  const reads = city.length;
  const out = await t.query(api.history.forRepairs, { violationIds: ["19112934", "19178388", "12345678", "19112934", "not a number"] });
  expect(out.map((r) => r.violationId)).toEqual(["19112934", "19178388"]);
  expect(out[0].earlier.map((e) => e.violationId)).toEqual(["18037661"]);
  expect(out[1].earlier).toEqual([]);
  expect(typeof out[0].checkedAt).toBe("number");
  expect(city).toHaveLength(reads);
});

test("forRepairs reads at most ten", async () => {
  const t = make();
  const ids = Array.from({ length: 12 }, (_, i) => String(19000000 + i));
  await t.run(async (ctx) => {
    for (const violationId of ids) await ctx.db.insert("repairHistory", { violationId, bbl: BBL, earlier: [], checkedAt: 1, rowsRead: 0 });
  });
  const out = await t.query(api.history.forRepairs, { violationIds: ids });
  expect(out.map((r) => r.violationId)).toEqual(ids.slice(0, 10));
  expect(city).toHaveLength(0);
});

test("a failed read throws, and nothing is kept from it", async () => {
  const t = make();
  answer = () => new Response("busy", { status: 503 });
  await expect(t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] })).rejects.toThrow(/HTTP 503/);
  answer = () => json({ error: "not rows" });
  await expect(t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] })).rejects.toThrow(/did not answer with rows/);
  expect(await kept(t)).toEqual([]);
  // The next check reads the city again, and keeps the chain.
  answer = theRows;
  expect(await t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] })).toMatchObject({ cited: ["19112934"] });
  expect(city).toHaveLength(3);
});

test("paused reads read nothing, and nothing but a parcel number and violation numbers is taken", async () => {
  const t = make();
  vi.stubEnv("NOTICE_PAUSE", "ingest");
  expect(await t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] })).toEqual({ read: 0, checked: 0, cited: [] });
  vi.unstubAllEnvs();
  await expect(t.action(internal.history.refresh, { bbl: "3050840061' OR '1'='1", violationIds: ["19112934"] })).rejects.toThrow(/not a parcel number/);
  expect(await t.action(internal.history.refresh, { bbl: BBL, violationIds: ["x", "19112934'"] })).toEqual({ read: 0, checked: 0, cited: [] });
  expect(city).toHaveLength(0);
  expect(await kept(t)).toEqual([]);
});

test("the daily refresh of the sample's card checks its repairs against the city's file; the refresh on a change to the file does not", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T06:25:00Z"));
  const t = make();
  const row = ROWS.find((r) => (r as { violationid: string }).violationid === "19112934") as Record<string, string>;
  await t.run(async (ctx) => {
    const sourceId = await ctx.db.insert("sources", { slug: "nyc-hpd", adapterVersion: 1, status: "active", emit: true, nextRunAt: 0, consecutiveFailures: 0, shadowCycles: 0 });
    await ctx.db.insert("subjects", { kind: "building", key: BBL, label: "155 LINDEN BOULEVARD, Brooklyn" });
    const snapshotId = await ctx.db.insert("snapshots", { sourceId, capturedAt: Date.now(), requestUrl: "https://city.test/file", httpStatus: 200, bodySha256: "0".repeat(64), rowCount: 1, degraded: false });
    const fields = {
      violationid: "19112934",
      bbl: BBL,
      class: "B",
      currentstatus: "NOV CERTIFIED ON TIME",
      currentstatusdate: "2026-09-18",
      certifiedbydate: "2026-09-18",
      inspectiondate: "2026-07-27",
      novdescription: row.novdescription,
      __subjectKind: "building",
      __subjectKey: BBL,
      __subjectLabel: "155 LINDEN BOULEVARD, Brooklyn",
    };
    const identityKey = `${BBL}/19112934`;
    const observationId = await ctx.db.insert("observations", { sourceId, snapshotId, identityKey, subjectKey: BBL, claimKind: "hpd.violation_status", assertedAt: "2026-09-18", capturedAt: Date.now(), fields, sigHash: "s", fullHash: "f" });
    await ctx.db.insert("current", { sourceId, identityKey, subjectKey: BBL, observationId, sigHash: "s", fullHash: "f", fields, updatedAt: Date.now() });
  });
  // A change to the housing file rebuilds the card, and reads nothing of the city's.
  expect(await t.mutation(internal.wall.refreshSampleAsk, {})).toBe(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(city).toHaveLength(0);
  expect(await kept(t)).toEqual([]);
  // The daily run checks the repair it could ask about, and the page can show what was found.
  expect(await t.mutation(internal.wall.refreshSampleAsk, { history: true })).toBe(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(city).toHaveLength(1);
  const out = await t.query(api.history.forRepairs, { violationIds: ["19112934"] });
  expect(out.map((r) => [r.violationId, r.earlier.map((e) => e.violationId)])).toEqual([["19112934", ["18037661"]]]);
});
