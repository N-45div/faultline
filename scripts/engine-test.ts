/**
 * Runs every adapter on the latest disk snapshot and proves the diff engine
 * closes the att.com trap: same bytes → zero changes; one edited field → one
 * change naming that field; a captcha-sized body → degraded, zero removals.
 *
 *   npx tsx scripts/engine-test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "../engine/adapters/index";
import { hashFields } from "../engine/canon";
import { diffRows } from "../engine/diff";
import { warnNoticeGap } from "../engine/rules";
import type { FetchBody, Observation, PrevIndex, SourceAdapter } from "../engine/types";

const snapDir = join("data", "snapshots");
const latest = readdirSync(snapDir).sort().at(-1);
if (!latest) throw new Error("no snapshots on disk");
const dir = join(snapDir, latest);
const now = new Date().toISOString();

const bodies: Record<string, FetchBody> = {
  "nyc-hpd": { kind: "text", text: readFileSync(join(dir, "nyc-hpd-certs.json"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
  "ny-warn": { kind: "text", text: readFileSync(join(dir, "ny-warn.csv"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
  "ca-warn": { kind: "bytes", bytes: new Uint8Array(readFileSync(join(dir, "ca-warn.xlsx"))), status: 200, url: "fixture", fetchedAt: now },
  "md-warn": { kind: "text", text: readFileSync(join(dir, "md-warn.html"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
  "co-warn": { kind: "text", text: readFileSync(join(dir, "co-warn.csv"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
  "nc-warn": { kind: "text", text: readFileSync(join(dir, "nc-warn.csv"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
  "va-warn": { kind: "text", text: readFileSync(join(dir, "va-warn.csv"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
};

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function observe(a: SourceAdapter<any>, body: FetchBody): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const raw of a.parse(body)) {
    const fields = a.normalise(raw);
    out.push({
      identityKey: a.identity(raw),
      subject: a.subjectOf(raw),
      claimKind: a.claimKind,
      assertedAt: a.assertedAt(raw),
      capturedAt: now,
      fields,
      sigHash: await hashFields(fields, a.noise, a.significant),
      fullHash: await hashFields(fields, a.noise),
      provenance: { sourceId: a.id, adapterVersion: a.version, requestUrl: "fixture", requestedAt: now, httpStatus: 200, bodySha256: "fixture", rowLocator: a.identity(raw) },
    });
  }
  return out;
}

const toPrev = (obs: Observation[]): PrevIndex =>
  Object.fromEntries(obs.map((o) => [o.identityKey, { sigHash: o.sigHash, fullHash: o.fullHash, fields: o.fields }]));

for (const id of Object.keys(adapters)) {
  const a = adapters[id];
  console.log(`\n== ${id} (${a.presence}, minRows ${a.health.minRows})`);
  const obs = await observe(a, bodies[id]);
  check(obs.length > 0, `parsed ${obs.length} rows`);
  const ids = new Set(obs.map((o) => o.identityKey));
  check(ids.size === obs.length, `identity is unique (${ids.size}/${obs.length})`);
  console.log(`       e.g. ${obs[0].identityKey}`);
  console.log(`       "${a.render(obs[0].fields)}"`);

  // 1. Same bytes twice → nothing.
  const prev = toPrev(obs);
  const same = diffRows(a, prev, obs);
  check(same.changes.length === 0 && same.silentUpdates === 0, `self-diff: ${same.changes.length} changes, ${same.silentUpdates} silent, ${same.unchanged} unchanged`);

  // 2. One insignificant field edited → stored silently, not emitted.
  const insig = Object.keys(obs[0].fields).find((k) => !a.significant.includes(k) && !k.startsWith("__") && typeof obs[0].fields[k] === "string")!;
  const silentObs = await observe(a, bodies[id]);
  silentObs[0].fields[insig] = String(silentObs[0].fields[insig]) + " (edited)";
  silentObs[0].fullHash = await hashFields(silentObs[0].fields, a.noise);
  const silent = diffRows(a, prev, silentObs);
  check(silent.changes.length === 0 && silent.silentUpdates === 1, `edit "${insig}" → 0 changes, ${silent.silentUpdates} silent update`);

  // 3. One significant field edited → exactly one change naming that field.
  const sig = a.significant[0];
  const changedObs = await observe(a, bodies[id]);
  const f = changedObs[0].fields;
  f[sig] = typeof f[sig] === "number" ? (f[sig] as number) + 1 : String(f[sig]) + "x";
  changedObs[0].sigHash = await hashFields(f, a.noise, a.significant);
  changedObs[0].fullHash = await hashFields(f, a.noise);
  const one = diffRows(a, prev, changedObs);
  check(one.changes.length === 1 && one.changes[0].kind === "changed" && one.changes[0].changed.join() === sig, `edit "${sig}" → 1 change on [${one.changes[0]?.changed.join(",")}]`);

  // 4. A new row → added. A dropped row → removed only for open-world sources.
  const dropped = obs.slice(1);
  const rem = diffRows(a, prev, dropped);
  const removed = rem.changes.filter((c) => c.kind === "removed").length;
  check(a.presence === "open_world" ? removed === 1 : removed === 0, `drop one row → ${removed} removed (${a.presence})`);
  if (removed) console.log(`       "${rem.changes.find((c) => c.kind === "removed")!.sentence}"`);

  // 5. A captcha-sized body → degraded, zero removals.
  const tiny = diffRows(a, prev, obs.slice(0, Math.min(3, a.health.minRows)));
  if (a.health.minRows > 0) check(tiny.degraded && tiny.changes.filter((c) => c.kind === "removed").length === 0, `3 rows → degraded=${tiny.degraded}, removals=0`);
}

// The statistic the product exists for, recomputed from today's files.
console.log("\n== warn.notice_gap");
for (const [id, jur, state] of [["ny-warn", "US-NY", "NY"], ["ca-warn", "US-CA", "CA"]] as const) {
  const obs = await observe(adapters[id], bodies[id]);
  const results = obs.map((o) => warnNoticeGap({ jurisdiction: jur, noticeDate: String(o.fields.noticeDate), effectiveDate: String(o.fields.effectiveDate), postedDate: String(o.fields.postedDate ?? o.fields.processedDate) }));
  const gaps = results.filter((r) => r.verdict === "gap").length;
  const late = results.filter((r) => r.postedAfterEffective).length;
  const zero = results.filter((r) => r.actualDays <= 0).length;
  console.log(`  ${state}: ${gaps}/${results.length} under the ${results[0].statutoryDays}-day statute · ${zero} with zero or negative days · ${late} posted after the layoff started`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
