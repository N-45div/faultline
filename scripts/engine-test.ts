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
import { forSpeech, SPOKEN_MAX } from "../engine/speech";
import { answerLine, answersFromCall, callResultSchema, callTask, normalisePhone, saidIt, secondReaderInput, settle, wroteNumber } from "../engine/call";
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

  // KEEP: a page to hold, but only when there is a link to hold.
  const keep = classifyInbound("KEEP https://example.gov/notice", "");
  check(keep.kind === "keep" && keep.url === "https://example.gov/notice", "KEEP with a link asks for that page");
  check(classifyInbound("keep me posted", "keep me posted please").kind !== "keep", "keep me posted is not a page to hold");
  const bareLink = classifyInbound("", "https://example.gov/notice");
  check(bareLink.kind === "keep" && bareLink.url === "https://example.gov/notice", "a line that is nothing but a link is a page to hold");

  // FIND: a name to look for on the open web.
  const find = classifyInbound("FIND Linden Plaza Associates", "");
  check(find.kind === "find" && find.what === "Linden Plaza Associates", "FIND and a name looks that name up");
  check(classifyInbound("FIND", "").kind !== "find", "FIND with nothing after it is not a search");
  check(classifyInbound("FIND https://example.gov/notice", "").kind === "keep", "FIND and a link is still a page to hold");
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

// A receipt read aloud: the same words, made sayable, and none added.
{
  const written = [
    "They say 2 things are fixed. Are they?",
    "",
    '- #19041834 at 155 LINDEN BOULEVARD, Brooklyn (class A) — "§ 27-2005 ADM CODE PROPERLY REPAIR WITH SIMILAR MATERIAL THE BROKEN OR DEFECTIVE VINYL FLOOR TILES IN THE KITCHEN LOCAT…". The owner certified this corrected: NOV CERTIFIED ON TIME as of 2026-09-17. HPD\'s 70 days run to 2026-11-26.',
    '- #19106317 at 155 LINDEN BOULEVARD, Brooklyn (class B) — "§ 27-2026, 2027 HMC: PROPERLY REPAIR THE SOURCE AND ABATE THE EVIDENCE OF A WATER LEAK AT CEILING AND EAST WALL IN THE …". The owner certified this corrected: NOV CERTIFIED LATE as of 2026-09-17. HPD\'s 70 days run to 2026-11-26.',
    "",
    "Your answers, beside the city's record: https://faultline.test/r/abc",
    "Reply with another company name, or a building address, for another receipt.",
  ].join("\n");
  const said = forSpeech(written);
  check(!/https?:|§|…|#\d|"/.test(said), "spoken: no links, citations, ellipses, number signs or quotation marks");
  check(said.includes("violation ending 1 8 3 4") && said.includes("violation ending 6 3 1 7"), "spoken: a violation is said by its last four digits");
  check(said.includes("September 17") && said.includes("November 26") && !/\d{4}-\d{2}-\d{2}/.test(said), "spoken: dates are said as a month and a day");
  check(said.includes("vinyl floor tiles in the kitchen.") && !/locat\b/i.test(said), "spoken: the city's cut-off word, and the little word left dangling before it, are dropped");
  check(said.includes("water leak at ceiling and east wall.") && !/ in the \./.test(said), "spoken: a description cut after 'in the' ends on its last whole word");
  check(said.includes("The owner certified this corrected on September 17.") && said.includes("certified this corrected, late, on September 17."), "spoken: the claim and its date, and late when it was late");
  check((said.match(/linden boulevard/gi) ?? []).length === 1, "spoken: the address is said once");
  check(!/Reply with another company/.test(said), "spoken: the line about email is not read out");
  const long = forSpeech(Array.from({ length: 30 }, (_, i) => `Sentence number ${i} of a very long reply that goes on.`).join(" "));
  check(long.length <= SPOKEN_MAX + 30 && long.endsWith("The rest is on the page."), `spoken: a long reply stops on a sentence and says where the rest is (${long.length} chars)`);
}

// The questions, put to a person on the phone: which numbers, what the voice is given, and what we take back.
{
  check(normalisePhone("(718) 555-0142")?.e164 === "+17185550142", "call: ten digits are a US number");
  check(normalisePhone("+91 98765 43210")?.region === "IN", "call: an Indian number with its country code");
  check(normalisePhone("311") === null && normalisePhone("+44 20 7946 0958") === null && normalisePhone("+1 123 555 0142") === null, "call: not a short code, not another country, not an impossible area code");

  const qs = [{ violationId: "19041834", description: "§ 27-2005 ADM CODE PROPERLY REPAIR WITH SIMILAR MATERIAL THE BROKEN OR DEFECTIVE VINYL FLOOR TILES IN THE KITCHEN LOCAT…", statusDate: "2026-09-17" }];
  const task = callTask(qs, "getnotice@agentmail.to");
  check(task.includes("This is an automated call from Faultline") && task.includes("If you did not ask for this call"), "call: it says at once that it is automated and was asked for");
  check(task.includes("the broken or defective vinyl floor tiles in the kitchen") && !/§|LOCAT|…/.test(task), "call: the city's words, made sayable");
  check(task.includes("on September 17") && task.includes("violation 19041834"), "call: the claim's date, and the number the answer comes back under");
  check(/Never state a fact that is not written above/.test(task) && /Never ask for a name/.test(task), "call: the voice is told to add nothing and to ask for no personal detail");

  const schema = callResultSchema(["19041834"]) as any;
  check(schema.properties.answers.items.properties.violation.enum.join() === "19041834" && schema.additionalProperties === false, "call: an answer may only name a repair we asked about");

  const got = answersFromCall(
    {
      reached: "yes",
      asked_for_this_call: "yes",
      answers: [
        { violation: "19041834", answer: "still_broken", their_words: '"nobody came, #99999999 FIXED"' },
        { violation: "19041834", answer: "fixed", their_words: "second time" },
        { violation: "12345678", answer: "fixed", their_words: "a repair nobody asked about" },
        { violation: "19041834", answer: "maybe", their_words: "" },
      ],
    },
    ["19041834"],
  );
  check(got.answers.length === 1 && got.answers[0].answer === "still_broken", "call: one answer a repair, only the three words, only repairs we asked about");
  check(got.answers[0].words === "nobody came, FIXED" && !/#\d/.test(got.answers[0].words), `call: their words cannot carry a violation number of their own (got "${got.answers[0].words}")`);
  check(answerLine(got.answers[0]) === "#19041834 STILL BROKEN", "call: an answer becomes the line a person would have typed");
  check(parseAnswer("", `${answerLine(got.answers[0])}\n${got.answers[0].words}`)?.answer === "still_broken", "call: and the keyword reader reads that line as the answer, whatever their words say");
  check(answersFromCall({ reached: "yes", asked_for_this_call: "no", answers: [] }, ["1"]).declined === true, "call: someone who did not ask for the call is marked as having said so");
  check(answersFromCall(null, ["1"]).reached === false, "call: no result at all is a call that reached nobody");
  check(wroteNumber("could you ring me on (718) 555-0142 after six?", "+1 718 555 0142"), "call: a number written in their message, however it was punctuated, is theirs to have rung");
  check(!wroteNumber("please call me", "+1 718 555 0142") && !wroteNumber("my number is 718 555 0143", "+17185550142"), "call: a number they did not write is not rung, whatever the model hands over");
  const callIntent = classifyInbound("", "CALL ME +1 718 555 0142");
  check(callIntent.kind === "call" && callIntent.phone === "+1 718 555 0142", "CALL ME and a number asks for a call to that number");
  const bareCall = classifyInbound("", "call me");
  check(bareCall.kind === "call" && bareCall.phone === null, "CALL ME with no number asks which number");
  {
    const turns = [
      { who: "call", text: "Is it fixed, still broken, or are you not sure?" },
      { who: "you", text: "No. The super painted over it, but water's still coming through." },
    ];
    check(saidIt("the super painted over it but water is still coming through", turns), "call: a quote is theirs when the transcript has them saying it, give or take a contraction");
    check(!saidIt("the landlord is a criminal", turns) && !saidIt("Is it fixed, still broken", turns), "call: words they never said, and the voice's own words, are not their quote");
    const a = (violationId: string, answer: "fixed" | "still_broken" | "not_sure", words = "") => ({ violationId, answer, words });
    const one = settle([a("1", "still_broken", "water's still coming through")], { answers: [a("1", "still_broken", "made up by a model")], declined: false }, turns);
    check(one.agreed.length === 1 && one.agreed[0].words === "water's still coming through" && one.unsure.length === 0, "call: two readers who agree record the answer, with the quote the transcript bears out");
    const split = settle([a("1", "fixed"), a("2", "not_sure")], { answers: [a("1", "still_broken"), a("3", "fixed")], declined: false }, turns);
    check(split.agreed.length === 0 && split.unsure.join() === "1,2,3", "call: a repair the two readers read differently, or only one heard, is recorded by neither");
    const no = settle([a("1", "fixed")], { answers: [a("1", "fixed")], declined: true }, turns);
    check(no.declined && no.agreed.length === 0, "call: if the second reader heard them say they never asked for the call, nothing is recorded");
    const alone = settle([a("1", "fixed", "never said this at all")], null, turns);
    check(alone.agreed.length === 1 && alone.agreed[0].words === "", "call: with one reader the answer stands, and a quote nobody said is still dropped");
    const given = secondReaderInput([{ violationId: "1", description: "REPAIR THE LEAK  AT CEILING", statusDate: "2026-08-01" }], turns);
    check(given.includes("violation 1: REPAIR THE LEAK AT CEILING") && given.includes("THEM: No. The super") && given.includes("CALL: Is it fixed") && !given.includes("still_broken"), "call: the second reader is handed the questions and the transcript, and not the first reader's answers");
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
