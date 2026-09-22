/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import actionCacheTest from "@convex-dev/action-cache/test";
import { api, internal } from "../convex/_generated/api";
import fixture from "../data/condition-history-3050840061.json?raw";

// A repair the city cited before, against an in-memory Convex: the city's file
// for the sample building is read once, through the Action Cache, by an
// internal action; what the rule finds is kept per violation; and the page's
// one query reads only that. The city's API is stood in for by sixteen of the
// building's real rows (data/condition-history-3050840061.json).

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => {
  const t = convexTest(schema, modules);
  actionCacheTest.register(t);
  return t;
};

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
});

const kept = (t: ReturnType<typeof make>) => t.run((ctx) => ctx.db.query("repairHistory").collect());

test("refresh reads the building's file once, through the cache, and keeps what the rule finds", async () => {
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

  // A second check that day reuses the rows the cache holds, and replaces the row it kept.
  await t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] });
  expect(city).toHaveLength(1);
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

test("a failed read throws, and nothing is cached or kept from it", async () => {
  const t = make();
  answer = () => new Response("busy", { status: 503 });
  await expect(t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] })).rejects.toThrow(/HTTP 503/);
  answer = () => json({ error: "not rows" });
  await expect(t.action(internal.history.refresh, { bbl: BBL, violationIds: ["19112934"] })).rejects.toThrow(/did not answer with rows/);
  expect(await kept(t)).toEqual([]);
  // The failures were not cached: the next check reads the city again, and keeps the chain.
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
