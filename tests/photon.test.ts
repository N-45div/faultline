/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { handleOf, spectrumSignature, verifySpectrumSignature } from "../engine/photon";

// The text door. Photon's webhook signature is checked the way its docs say,
// and a signed text is answered by the same hands as an email — stored once
// however many times it is delivered, and replied to by text.

const modules = import.meta.glob("../convex/**/*.*s");
const make = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};
type T = ReturnType<typeof make>;

const SECRET = "5".repeat(64);
const HANDLE = "+15550100";
const BBL = "3050840061";
const VIOLATION = "19114271";
const LABEL = "155 LINDEN BOULEVARD, Brooklyn";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  vi.stubEnv("SPECTRUM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("CONVEX_SITE_URL", "https://faultline.test");
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const nowSec = () => Math.floor(Date.now() / 1000);

function payload(text: string, id = "spc-msg-00000000-0000-4000-8000-000000000001", over: Record<string, unknown> = {}) {
  const space = { id: `any;-;${HANDLE}`, platform: "iMessage", type: "dm", phone: "shared" };
  return JSON.stringify({
    event: "messages",
    space,
    message: {
      id,
      platform: "iMessage",
      direction: "inbound",
      timestamp: new Date().toISOString(),
      sender: { id: HANDLE, platform: "iMessage" },
      space,
      content: { type: "text", text },
      ...over,
    },
  });
}

async function post(t: T, body: string, opts: { ts?: string; sig?: string } = {}) {
  const ts = opts.ts ?? String(nowSec());
  const sig = opts.sig ?? (await spectrumSignature(SECRET, ts, body));
  return t.fetch("/hooks/photon", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Spectrum-Event": "messages", "X-Spectrum-Timestamp": ts, "X-Spectrum-Signature": sig },
    body,
  });
}

async function seed(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subjects", { kind: "building", key: BBL, label: LABEL });
    await ctx.db.insert("attestations", {
      email: `photon:${HANDLE}`,
      subjectKey: BBL,
      violationId: VIOLATION,
      askedAt: Date.now() - 60_000,
      askedStatus: "NOV CERTIFIED ON TIME",
      askedStatusDate: "2026-09-10",
      certifiedBy: "2026-09-10",
      hazardClass: "A",
      description: "POST A PROPER NOTICE REGARDING RENT STABILIZATION LAW",
    });
  });
}

test("the signature is checked as Photon's docs describe it", async () => {
  const body = payload("hi");
  const ts = String(nowSec());
  const sig = await spectrumSignature(SECRET, ts, body);
  expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
  expect(await verifySpectrumSignature({ secret: SECRET, timestamp: ts, signature: sig, rawBody: body, nowSec: nowSec() })).toBe("ok");
  expect(await verifySpectrumSignature({ secret: SECRET, timestamp: ts, signature: sig, rawBody: body + " ", nowSec: nowSec() })).toBe("bad");
  expect(await verifySpectrumSignature({ secret: SECRET, timestamp: ts, signature: sig, rawBody: body, nowSec: nowSec() + 301 })).toBe("stale");
  expect(await verifySpectrumSignature({ secret: SECRET, timestamp: null, signature: sig, rawBody: body, nowSec: nowSec() })).toBe("missing");
  expect(handleOf(`any;-;${HANDLE}`)).toBe(HANDLE);
  expect(handleOf(`photon:${HANDLE}`)).toBe(HANDLE);
});

test("a signed text answering one of our questions is kept and replied to by text, once however often it is delivered", async () => {
  const t = make();
  await seed(t);
  const body = payload(`#${VIOLATION} STILL BROKEN`);
  const first = await post(t, body);
  expect(first.status).toBe(200);
  const again = await post(t, body);
  expect(again.status).toBe(200);

  const rows = await t.run(async (ctx) => ({
    inbox: await ctx.db.query("inbox").collect(),
    receipts: await ctx.db.query("receipts").collect(),
    answered: (await ctx.db.query("attestations").collect()).filter((r) => r.answer === "still_broken"),
  }));
  expect(rows.inbox).toHaveLength(1);
  expect(rows.inbox[0]).toMatchObject({ inboxId: "photon", fromAddress: `photon:${HANDLE}`, replied: true });
  expect(rows.receipts).toHaveLength(1);
  expect(rows.receipts[0].text).toContain("Kept, dated: you said still broken on 2026-09-14.");
  expect(rows.receipts[0].text).toContain("Reply STOP to stop.");
  expect(rows.receipts[0].text).not.toContain("you are getting this because");
  expect(rows.answered).toHaveLength(1);
});

test("a bad or stale signature stores nothing", async () => {
  const t = make();
  await seed(t);
  const body = payload(`#${VIOLATION} FIXED`);
  expect((await post(t, body, { sig: "v0=" + "0".repeat(64) })).status).toBe(401);
  expect((await post(t, body, { ts: String(nowSec() - 3_600) })).status).toBe(400);
  const inbox = await t.run((ctx) => ctx.db.query("inbox").collect());
  expect(inbox).toHaveLength(0);
});

test("outbound echoes and group chats are ignored", async () => {
  const t = make();
  await seed(t);
  expect(await (await post(t, payload("hi", "spc-msg-2", { direction: "outbound" }))).text()).toBe("ignored");
  const group = JSON.parse(payload("hi", "spc-msg-3"));
  group.space.type = "group";
  expect(await (await post(t, JSON.stringify(group))).text()).toBe("ignored");
  const inbox = await t.run((ctx) => ctx.db.query("inbox").collect());
  expect(inbox).toHaveLength(0);
});
