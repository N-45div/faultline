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
import { askFrom, challengeDeadline, fixedClaim, nextStepFor, parseAnswer, pickAsks, secondWordLine } from "../engine/hpd";
import { classifyInbound } from "../engine/intent";
import { changedLines } from "../engine/evidence";
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
  "nj-warn": { kind: "bytes", bytes: new Uint8Array(readFileSync(join(dir, "nj-warn.xlsx"))), status: 200, url: "fixture", fetchedAt: now },
  "nyc-restaurants": { kind: "text", text: readFileSync(join(dir, "nyc-restaurants.json"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
  "wi-warn": { kind: "text", text: readFileSync(join(dir, "wi-warn.html"), "utf8"), status: 200, url: "fixture", fetchedAt: now },
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

  // 3b. Our definition changing is not the state editing: a signature that
  // moved with no significant field moving is a silent update, never "changed".
  {
    const key = obs[0].identityKey;
    const redefined: PrevIndex = { ...prev, [key]: { ...prev[key], sigHash: "definition-changed", fullHash: "definition-changed" } };
    const r = diffRows(a, redefined, obs);
    check(r.changes.filter((c) => c.identityKey === key).length === 0 && r.silentUpdates >= 1, `signature moved, fields did not → 0 changes, silent update`);
  }

  // 4. A new row → added. A dropped row → removed only for open-world sources.
  const dropped = obs.slice(1);
  const rem = diffRows(a, prev, dropped);
  const removed = rem.changes.filter((c) => c.kind === "removed").length;
  check(a.presence === "closed_world" ? removed === 0 : removed === 1, `drop one row → ${removed} removed (${a.presence})`);
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

// 6. The tenant loop: the city's fixed claims, and a person's answer to "Is it fixed?".
console.log("\n== tenant loop");
{
  check(fixedClaim("NOV CERTIFIED ON TIME") === "owner" && fixedClaim("VIOLATION CLOSED") === "city" && fixedClaim("VIOLATION DISMISSED") === null, "fixed claims: owner, city, none");
  const ask = askFrom({ violationid: "17321000", currentstatus: "NOV CERTIFIED LATE", currentstatusdate: "2026-09-10", certifiedbydate: "2026-09-08", class: "C", novdescription: "repair the broken or defective plastered surfaces" });
  check(!!ask && ask.violationId === "17321000" && ask.certifiedBy === "2026-09-08", "askFrom reads the row");
  check(!!ask && challengeDeadline(ask) === "2026-11-17", `HPD's 70 days from 2026-09-08 run to 2026-11-17 (got ${ask && challengeDeadline(ask)})`);
  const quoted = "STILL BROKEN\n\nOn Mon, Sep 14, 2026 at 9:02 AM Faultline <getnotice@agentmail.to> wrote:\n> They say it's fixed. Is it?\n> - #17321000 at 249 East 37 Street, Brooklyn (class C)";
  const a1 = parseAnswer("Re: Is it fixed?", quoted);
  check(a1?.answer === "still_broken" && a1.violationId === "17321000", "STILL BROKEN over a quoted number → still_broken #17321000");
  const a2 = parseAnswer("Re: Is it fixed?", "#17321000 fixed, thanks\n> …");
  check(a2?.answer === "fixed" && a2.violationId === "17321000" && a2.note === "thanks", `'#… fixed, thanks' → fixed, note "thanks" (got ${JSON.stringify(a2)})`);
  const a3 = parseAnswer("Re: Is it fixed?", "not sure, the super came but I haven't checked the ceiling");
  check(a3?.answer === "not_sure" && a3.note.length > 0, "not sure, with a note");
  check(parseAnswer("Re: Is it fixed?", "yes") === null, "'yes' alone is a FOLLOW, not an answer");
  check(parseAnswer("about my job", "my fixed-term contract ended on Friday") === null, "'fixed-term' is not an answer");
  check(parseAnswer("my layoff letter", "I got a letter saying my position is being eliminated and the leak was fixed ".repeat(8)) === null, "a long letter with 'fixed' in it is not an answer");
  const signed = parseAnswer("Re: Is it fixed?", "#17321000 STILL BROKEN - the leak is still there\n\n--\nSent via AgentMail\n\nOn Mon, Sep 14, 2026 Faultline wrote:\n> …");
  check(signed?.answer === "still_broken" && signed.note === "the leak is still there", `a mail signature is not part of the note (got ${JSON.stringify(signed?.note)})`);
  const ctl = askFrom({ violationid: "1", currentstatus: "VIOLATION CLOSED", currentstatusdate: "2026-09-10", novdescription: "AT THE BUILDING\u001aS ENTRANCE" });
  check(ctl?.description === "AT THE BUILDING'S ENTRANCE", "a control byte in the city's text reads as the apostrophe it was");
  check(classifyInbound("Re: Is it fixed?", quoted).kind === "answer", "classifyInbound routes the reply before the letter test");
  check(classifyInbound("Re: Is it fixed?", quoted, { answers: false }).kind !== "answer", "…and not when nobody asked");

  // ASK: on request, only the owner's certifications still inside HPD's 70 days.
  const rowsHeld = [
    { violationid: "1", currentstatus: "NOV CERTIFIED ON TIME", currentstatusdate: "2026-09-10", certifiedbydate: "2026-09-10", class: "C", novdescription: "leak" },
    { violationid: "2", currentstatus: "NOV CERTIFIED LATE", currentstatusdate: "2026-05-01", certifiedbydate: "2026-05-01", class: "B", novdescription: "old" },
    { violationid: "3", currentstatus: "VIOLATION CLOSED", currentstatusdate: "2026-09-12", certifiedbydate: null, class: "A", novdescription: "closed" },
    { violationid: "4", currentstatus: "NOV SENT OUT", currentstatusdate: "2026-09-12", certifiedbydate: null, class: "A", novdescription: "open" },
  ];
  const picked = pickAsks(rowsHeld, "2026-09-14");
  check(picked.length === 1 && picked[0].violationId === "1", `ASK picks only open owner certifications (got ${picked.map((p) => p.violationId).join(",")})`);
  check(classifyInbound("ASK 155 Linden Boulevard, Brooklyn", "").kind === "ask", "ASK <address> in the subject is an ask");
  const bare = classifyInbound("Re: 155 LINDEN BOULEVARD", "ask\n\nOn Mon, Sep 14, 2026 Faultline wrote:\n> …");
  check(bare.kind === "ask" && bare.query === "", "a bare ASK in a thread asks about that thread's building");
  check(classifyInbound("Re: ASK 155 Linden", "#17321000 still broken").kind === "answer", "our ASK subject coming back on a reply does not ask again");
  check(
    secondWordLine({ answer: "still_broken", saidOn: "2026-09-13", violationId: "1", where: "155 LINDEN BOULEVARD, Brooklyn", status: "FALSE CERTIFICATION", on: "2026-09-20" }).startsWith("The city agrees with you: HPD stamped #1 at"),
    "the city's second word leads with agreement when the person said still broken",
  );
  check(nextStepFor("VIOLATION CLOSED") !== nextStepFor("NOV CERTIFIED ON TIME"), "a closed violation gets a different next step from a certification");
}

// Firecrawl's git-diff, cut to what moved.
{
  const fc = "diff --git a/previous b/current\n--- a/previous\n+++ b/current\n@@ -3,2 +3,2 @@\n context line\n-| 2026-09-01 | Acme | 40 |\n+| 2026-09-01 | Acme | 45 |\n unchanged";
  check(
    changedLines(fc) === "@@ -3,2 +3,2 @@\n-| 2026-09-01 | Acme | 40 |\n+| 2026-09-01 | Acme | 45 |",
    "Firecrawl's diff keeps the hunk and the lines that moved, not its header or the context",
  );
  const long = changedLines("@@ -1 +1 @@\n" + Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n"), 10);
  check(long.split("\n").length === 11 && long.endsWith("… 91 more lines"), `a diff past the cap says how much it left out (got "${long.split("\n").at(-1)}")`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
