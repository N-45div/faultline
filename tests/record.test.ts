/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// A person's own page says when the city's housing file is read for their
// buildings. recordChecks opens by the same private link as the record, and
// hands back the file's clock and which of their buildings it reads: nothing
// about anyone else's.

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => convexTest(schema, modules);
type T = ReturnType<typeof make>;

const TOKEN = "0123456789abcdef".repeat(2) + "01234567";
const OTHER_TOKEN = "f".repeat(40);
const ON_LIST = "3050840061";
const OFF_LIST = "1000010001";
const STRANGERS = "2000020002";
const LAST = Date.UTC(2026, 8, 22, 9, 0);
const NEXT = Date.UTC(2026, 8, 22, 12, 5);

async function seed(t: T, source: { status?: "active" | "paused"; lastStatus?: string } = {}) {
  await t.run(async (ctx) => {
    const sourceId = await ctx.db.insert("sources", {
      slug: "nyc-hpd",
      adapterVersion: 1,
      status: source.status ?? "active",
      emit: true,
      nextRunAt: NEXT,
      lastRunAt: LAST,
      lastStatus: source.lastStatus ?? "200 · 1812 rows",
      consecutiveFailures: 0,
      shadowCycles: 0,
    });
    await ctx.db.insert("records", { email: "tenant@example.com", token: TOKEN, createdAt: LAST });
    await ctx.db.insert("records", { email: "stranger@example.com", token: OTHER_TOKEN, createdAt: LAST });
    const asked = (email: string, subjectKey: string, violationId: string) =>
      ctx.db.insert("attestations", {
        email,
        subjectKey,
        violationId,
        askedAt: LAST,
        askedStatus: "NOV CERTIFIED ON TIME",
        askedStatusDate: "2026-09-18",
        certifiedBy: "2026-09-18",
        hazardClass: "B",
        description: "REPAIR THE BROKEN OR DEFECTIVE PLASTERED SURFACES IN THE KITCHEN",
      });
    await asked("tenant@example.com", ON_LIST, "19112934");
    await asked("tenant@example.com", OFF_LIST, "19112935");
    await asked("stranger@example.com", STRANGERS, "19112936");
    await ctx.db.insert("targets", { sourceId, subjectKey: ON_LIST, active: true, addedBy: "case" });
    await ctx.db.insert("targets", { sourceId, subjectKey: OFF_LIST, active: false, addedBy: "case" });
    await ctx.db.insert("targets", { sourceId, subjectKey: STRANGERS, active: true, addedBy: "case" });
  });
}

test("a bad or unknown link opens nothing", async () => {
  const t = make();
  await seed(t);
  expect(await t.query(api.attest.recordChecks, { token: "short" })).toBeNull();
  expect(await t.query(api.attest.recordChecks, { token: "e".repeat(40) })).toBeNull();
});

test("the file's clock, and only this person's buildings that it reads", async () => {
  const t = make();
  await seed(t);
  expect(await t.query(api.attest.recordChecks, { token: TOKEN })).toEqual({
    everyHours: 3,
    lastReadAt: LAST,
    lastReadFailed: false,
    nextReadAt: NEXT,
    onList: [ON_LIST],
  });
  expect((await t.query(api.attest.recordChecks, { token: OTHER_TOKEN }))?.onList).toEqual([STRANGERS]);
});

test("a failed read says so, and a paused file promises no next read", async () => {
  const t = make();
  await seed(t, { status: "paused", lastStatus: "error: HTTP 503" });
  const out = await t.query(api.attest.recordChecks, { token: TOKEN });
  expect(out).toMatchObject({ lastReadAt: LAST, lastReadFailed: true, nextReadAt: null });
});

test("before the file was ever read, there is no last read and no list", async () => {
  const t = make();
  await t.run(async (ctx) => {
    await ctx.db.insert("records", { email: "tenant@example.com", token: TOKEN, createdAt: LAST });
  });
  expect(await t.query(api.attest.recordChecks, { token: TOKEN })).toEqual({
    everyHours: 3,
    lastReadAt: null,
    lastReadFailed: false,
    nextReadAt: null,
    onList: [],
  });
});
