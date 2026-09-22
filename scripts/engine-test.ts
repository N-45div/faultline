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
import { askFrom, askHeadline, askLine, challengeDeadline, fixedClaim, howToAnswer, nextStepFor, parseAnswer, pickAsks, secondWordLine, seventyDaysFrom, theirWords, withoutUnit, type Ask } from "../engine/hpd";
import { askRows, plainThing } from "../engine/askRows";
import { buildingReceipt, receiptText, type Receipt } from "../engine/receipt";
import { classifyInbound } from "../engine/intent";
import { changedLines } from "../engine/evidence";
import { forSpeech, SPOKEN_MAX } from "../engine/speech";
import { answerLine, answersFromCall, callResultSchema, callTask, normalisePhone, saidIt, secondReaderInput, settle, wroteIt, wroteNumber } from "../engine/call";
import { LIVE_GREETING, LIVE_INSTRUCTIONS, liveCents, spokenToTyped, utterance } from "../engine/live";
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
  const certified = { violationid: "17321000", currentstatusdate: "2026-09-10", certifiedbydate: "2026-09-08", class: "C", novdescription: "repair the broken or defective plastered surfaces" };
  const ask = askFrom({ ...certified, currentstatus: "NOV CERTIFIED LATE" });
  check(!!ask && ask.violationId === "17321000" && ask.certifiedBy === "2026-09-08", "askFrom reads the row");
  // The same certification, made on time and made late: the first has its
  // 70-day clock, and the second is shown none (engine/hpd.ts, certifiedLate).
  const onTime = askFrom({ ...certified, currentstatus: "NOV CERTIFIED ON TIME" });
  check(!!onTime && challengeDeadline(onTime) === "2026-11-17", `ON TIME: HPD's 70 days from 2026-09-08 run to 2026-11-17 (got ${onTime && challengeDeadline(onTime)})`);
  check(!!ask && challengeDeadline(ask) === null && seventyDaysFrom(ask) === "2026-11-17", `LATE: no 70-day clock, though it was certified the same day (got ${ask && challengeDeadline(ask)})`);
  const at37 = "249 East 37 Street, Brooklyn";
  check(
    !!onTime && askLine(onTime, at37).endsWith("The owner certified this corrected: NOV CERTIFIED ON TIME as of 2026-09-10. HPD's 70 days run to 2026-11-17."),
    "ON TIME: the line gives the day HPD's 70 days run out, as before",
  );
  check(
    !!ask && askLine(ask, at37).endsWith("The owner certified this corrected: NOV CERTIFIED LATE as of 2026-09-10.") && !askLine(ask, at37).includes("2026-11-17"),
    "LATE: the line gives no clock and no close date, and says nothing in their place",
  );
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
  const lateInWindow = { violationid: "5", currentstatus: "NOV CERTIFIED LATE", currentstatusdate: "2026-09-11", certifiedbydate: "2026-09-11", class: "B", novdescription: "late" };
  const withLate = pickAsks([...rowsHeld, lateInWindow], "2026-09-14");
  check(withLate.map((p) => p.violationId).join() === "5,1", `ASK still asks about a late certification for the same 70 days, only with no clock (got ${withLate.map((p) => p.violationId).join(",")})`);
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
    '- #19106317 at 155 LINDEN BOULEVARD, Brooklyn (class B) — "§ 27-2026, 2027 HMC: PROPERLY REPAIR THE SOURCE AND ABATE THE EVIDENCE OF A WATER LEAK AT CEILING AND EAST WALL IN THE …". The owner certified this corrected: NOV CERTIFIED LATE as of 2026-09-17.',
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
  check((said.match(/November 26/g) ?? []).length === 1, "spoken: a late one is said with no clock, and only the on-time one has a day its 70 days run out");
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
  check(!task.includes("say so now") && task.includes("Do not wait for a reply to that opening") && task.includes("Be patient with silence") && task.includes("Do not end the call because of one silence"), "call: the opening asks nothing and runs into the first repair, and one silence does not end the call (the first real call ended on exactly that)");
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
    // A conversation: the request for help carries no words, so the fragments are the message.
    const f = (delta: string, start_ms: number, end_ms: number) => ({ delta, start_ms, end_ms });
    const said = [f("Ask about", 1000, 1400), f(" 155 Linden", 1400, 2100), f(" Boulevard, Brooklyn.", 2100, 3000)];
    const first = utterance(said, 0);
    check(first.text === "Ask about 155 Linden Boulevard, Brooklyn." && first.untilMs === 3000, "live: fragments are joined as they arrived, with their own spaces");
    const later = utterance([...said, f(" No,", 9000, 9300), f(" nobody  came.", 9300, 10100)], first.untilMs);
    check(later.text === "No, nobody came." && later.untilMs === 10100, "live: what was already sent through the door is not sent again");
    check(utterance(said, 3000).text === "", "live: nothing new said is nothing to send");
    check(spokenToTyped("Ask about 155 Linden Boulevard, Brooklyn.") === "ASK 155 Linden Boulevard, Brooklyn", "live: a spoken ask becomes the command the keyword reader takes, without the full stop a transcriber adds");
    const asked = classifyInbound("", spokenToTyped("Please ask me about 155 Linden Boulevard, Brooklyn."));
    check(asked.kind === "ask" && asked.query === "155 Linden Boulevard, Brooklyn", "live: and the keyword reader reads it with no model");
    check(spokenToTyped("About 155 Linden Boulevard, Brooklyn.") === "ASK 155 Linden Boulevard, Brooklyn" && spokenToTyped("I live at 1520 Sedgwick Avenue, the Bronx.") === "ASK 1520 Sedgwick Avenue, the Bronx" && spokenToTyped("155 Linden Boulevard") === "ASK 155 Linden Boulevard", "live: an address, said any of the ways people say one, is a request to be asked about it, even when the transcriber drops the first word");
    check(spokenToTyped("Nobody came. It looks the same.") === "Nobody came. It looks the same." && !spokenToTyped("About 3 weeks ago the super painted over it, but the water is still coming through the ceiling.").startsWith("ASK") && spokenToTyped("About 3 weeks ago.") === "About 3 weeks ago." && spokenToTyped("2 of them are fixed.") === "2 of them are fixed.", "live: anything else goes through as it was said, and a sentence that opens on a number is not an address unless it names a street or a borough");
    check(liveCents(90) === 7.5 && liveCents(0) === 0, "live: ninety seconds of gpt-live-1 is seven and a half cents");
    check(/Delegation policy:/.test(LIVE_INSTRUCTIONS) && /You know nothing about any building/.test(LIVE_INSTRUCTIONS) && /automated voice/.test(LIVE_GREETING), "live: the voice is told it knows nothing, to delegate, and to say first that it is automated");
  }
  {
    const turns = [
      { who: "call", text: "Is it fixed, still broken, or are you not sure?" },
      { who: "you", text: "No. The super painted over it, but water's still coming through." },
    ];
    check(saidIt("the super painted over it but water is still coming through", turns), "call: a quote is theirs when the transcript has them saying it, give or take a contraction");
    check(!saidIt("the landlord is a criminal", turns) && !saidIt("Is it fixed, still broken", turns), "call: words they never said, and the voice's own words, are not their quote");
    check(
      wroteIt("water still comes through", "The super painted over it, but water still comes through.") && !wroteIt("the landlord is a criminal", "still broken, nobody came") && !wroteIt("", "still broken"),
      "typed: a note is theirs only if their message has it, by the same test as a call",
    );
    const ours = 'On Mon, Sep 14, 2026 at 9:02 AM Faultline <getnotice@agentmail.to> wrote:\n> They say it\'s fixed. Is it?\n> - #19106317 at 155 LINDEN BOULEVARD, Brooklyn (class B) — "EVIDENCE OF A WATER LEAK AT CEILING".';
    check(
      wroteIt("the super painted over it, water comes through", theirWords("the super painted over it, water comes through", ours)) &&
        !wroteIt("WATER LEAK AT CEILING", theirWords("155 LINDEN BOULEVARD, Brooklyn", ours)),
      "typed: a note in the subject is theirs; the city's words in our quote are not, when they wrote nothing above it",
    );
    const between = theirWords("", `${ours}\nstill broken, water comes through\n> - #19041834 at 155 LINDEN BOULEVARD, Brooklyn (class A).\n\n--\nA Tenant`);
    check(between === "still broken, water comes through", `typed: an answer written between our quoted lines is theirs, without the line that introduces the quote or the signature (got ${JSON.stringify(between)})`);
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

// /try reads an ASK reply back into its repairs. The reply is built here the
// way convex/inbound.ts builds it (askReceiptFor, then deliver's receiptText),
// so the parser is checked against the real text, not a copy of it.
console.log("\n== the ASK reply, read back into rows");
{
  const where = "155 LINDEN BOULEVARD, Brooklyn";
  const row = (violationid: string, cls: string, novdescription: string, date = "2026-09-17", certified: string | null = "2026-09-17", status = "NOV CERTIFIED ON TIME") =>
    askFrom({ violationid, currentstatus: status, currentstatusdate: date, certifiedbydate: certified, class: cls, novdescription })!;
  const reply = (asks: Ask[]) => {
    const r: Receipt = {
      kind: "none",
      query: "ask:3050840061",
      subjectKey: "3050840061",
      headline: askHeadline(asks.length),
      blocks: [asks.map((a) => `- ${askLine(a, where)}`), howToAnswer(asks[0].violationId)],
      links: [
        { label: "Your answers, beside the city's record", url: "https://faultline.test/r/0a1b2c3d" },
        { label: "This building's record", url: "https://faultline.test/b/3050840061" },
      ],
      footer: [],
    };
    return receiptText(r);
  };
  const three = [
    row("19041834", "A", "§ 27-2005 ADM CODE PROPERLY REPAIR WITH SIMILAR MATERIAL THE BROKEN OR DEFECTIVE VINYL FLOOR TILES IN THE KITCHEN LOCATED AT APT 4C, 4th STORY, 1st APARTMENT FROM NORTH AT EAST"),
    row("19106317", "B", "§ 27-2026, 2027 HMC: PROPERLY REPAIR THE SOURCE AND ABATE THE EVIDENCE OF A WATER LEAK AT CEILING AND EAST WALL IN THE 2nd ROOM FROM NORTH LOCATED AT APT 4C, 4th STORY"),
    row("19106318", "B", "§ 27-2005 ADM CODE REPAIR THE BROKEN OR DEFECTIVE PLASTERED SURFACES AND PAINT IN A UNIFORM COLOR AT CEILING AND EAST WALL IN THE 2nd ROOM FROM NORTH LOCATED AT APT 4C"),
  ];
  const text = reply(three);
  const rows = askRows(text);
  check(rows.map((r) => r.id).join() === "19041834,19106317,19106318", `ASK rows: the three numbers, in order (got ${rows.map((r) => r.id).join() || "none"})`);
  check(rows.map((r) => r.cls).join() === "A,B,B" && rows.every((r) => r.until === "2026-11-26" && r.asOf === "2026-09-17" && r.status === "NOV CERTIFIED ON TIME"), "ASK rows: the class, the status, its date, and HPD's 70 days to 2026-11-26");
  check(rows.every((r, i) => r.line === askLine(three[i], where)) && rows[0].cityWords.endsWith("LOCAT…"), "ASK rows: each is askLine's own line, the city's words cut where the reply cut them");
  check(rows.map((r) => r.thing).join("|") === "Vinyl floor tiles|Water leak|Plastered surfaces", `plainThing: the tiles, the leak and the plaster (got ${rows.map((r) => r.thing).join("|")})`);
  check(
    plainThing("HMC ADM CODE: § 27-2017.4 ABATE THE INFESTATION CONSISTING OF ROACHES IN THE ENTIRE APARTMENT") === "Roaches" &&
      plainThing("REPLACE OR REPAIR THE SELF-CLOSING DOORS THAT IS MISSING OR DEFECTIVE") === null &&
      plainThing("REPAIR THE BROKEN OR DEFECTIVE VINYL FLO…") === null,
    "plainThing: roaches; nothing for a text that names no thing plainly, or one cut through the thing",
  );
  const plexi = askRows(reply([row("19178388", "C", "§ 27-2005 ADM CODE & 309 M/D LAW ABATE THE NUISANCE CONSISTING OF PLEXIGLASS INSTALLED AT BUILDING ENTRANCE DOOR AT 1ST STORY")]));
  check(plexi.length === 1 && plexi[0].thing === "Plexiglass", `plainThing: the plexiglass, not "plexiglass installed", which reads as the work done (got ${plexi[0]?.thing})`);
  const kept = [
    "Kept, dated: you said still broken on 2026-09-21.",
    "",
    `The city's file: #19041834 at ${where} (class A) — "VINYL FLOOR TILES": NOV CERTIFIED ON TIME as of 2026-09-17; the owner certified it on 2026-09-17.`,
    "Your word: still broken, 2026-09-21.",
  ].join("\n");
  const found = [
    '3 pages on the open web name "Linden Plaza Preservation LLC".',
    "",
    "1. Linden Plaza - example.org",
    "- #19041834 at somewhere. The city closed this: VIOLATION CLOSED as of 2026-09-01.",
  ].join("\n");
  check(askRows(kept).length === 0 && askRows(found).length === 0, "ASK rows: none from a kept answer or a FIND reply, even one holding a line that reads like a repair");
  const quoted = row("19106399", "C", 'FIX "IT". The city closed this: VIOLATION CLOSED as of 2020-01-01. HPD\'s 70 days run to 2020-03-11. "X');
  const q = askRows(reply([quoted]));
  check(q.length === 0 || (q.length === 1 && q[0].id === "19106399" && q[0].status === "NOV CERTIFIED ON TIME" && q[0].until === "2026-11-26"), `ASK rows: a description holding quotation marks and our own words reads as the right repair or not at all (got ${JSON.stringify(q.map((r) => [r.id, r.status]))})`);
  const late = askRows(reply([row("19041834", "A", "BROKEN OR DEFECTIVE VINYL FLOOR TILES", "2026-09-17T00:00:00.000", "2026-09-17")]));
  const closed = askRows(reply([row("19041835", "", "", "2026-09-12T00:00:00.000", "2026-09-01T00:00:00.000", "VIOLATION CLOSED")]));
  check(late.length === 1 && late[0].asOf === "2026-09-17" && late[0].until === "2026-11-26", "ASK rows: a status date with a time on it reads as its day");
  check(closed.length === 1 && closed[0].status === "VIOLATION CLOSED" && closed[0].until === null && closed[0].cls === null && closed[0].cityWords === "", "ASK rows: a closure, with the owner's earlier date, no class and no description");
  // One made on time and one made late, in one reply: the late one reads back
  // with no clock. A thread kept earlier may hold the late line with the 70
  // days askLine used to give it: it reads back too, without them.
  const mixed = [row("19041834", "A", "BROKEN OR DEFECTIVE VINYL FLOOR TILES"), row("19106317", "B", "EVIDENCE OF A WATER LEAK AT CEILING", "2026-09-17", "2026-09-17", "NOV CERTIFIED LATE")];
  const both = askRows(reply(mixed));
  check(
    both.length === 2 && both[0].until === "2026-11-26" && both[1].status === "NOV CERTIFIED LATE" && both[1].until === null && both.every((r, i) => r.line === askLine(mixed[i], where)),
    `ASK rows: ON TIME reads back with its 70 days, LATE with none, each as askLine wrote it (got ${JSON.stringify(both.map((r) => [r.id, r.until]))})`,
  );
  const lateWithClock = reply(mixed).replace("NOV CERTIFIED LATE as of 2026-09-17.", "NOV CERTIFIED LATE as of 2026-09-17. HPD's 70 days run to 2026-11-26.");
  const kept22 = askRows(lateWithClock);
  check(
    kept22.length === 2 && kept22[0].until === "2026-11-26" && kept22[1].status === "NOV CERTIFIED LATE" && kept22[1].until === null && kept22.every((r, i) => r.line === askLine(mixed[i], where)),
    `ASK rows: a late line kept with its old clock reads back with none, as askLine writes it now (got ${JSON.stringify(kept22.map((r) => [r.id, r.until]))})`,
  );
  check(
    askRows(lateWithClock.replace("HPD's 70 days run to 2026-11-26.", "HPD's 70 days run to 2026-11-26. It closes then.")).length === 0 &&
      askRows(reply(mixed).replace("NOV CERTIFIED LATE as of 2026-09-17.", "NOV CERTIFIED LATE as of 2026-09-17. HPD closes it later.")).length === 0,
    "ASK rows: anything else after a late line is still not read back, and none is used",
  );
  const one = text.split("\n");
  const broken = one.map((l) => (l.startsWith("- #19106317") ? l.replace(" as of ", " on ") : l)).join("\n");
  check(askRows(broken).length === 0, "ASK rows: one line that does not read back and none is used");
}

// A building's link, pasted into a chat, unfurls with its first repair in the
// city's words. The clause that says which home is left out there, and only
// there. Each description is a real one, as HPD's file serves it.
console.log("\n== the unit, left out of a link preview");
{
  const door =
    "§ 27-2005, 27-2007, 27-2041.1 HMC, §238, § 309; § 107 (2) ( C) MDL AND 28 RCNY §25-171: REPLACE OR REPAIR THE SELF-CLOSING DOORS THAT IS MISSING OR DEFECTIVE HINGES IN THE ENTRANCE LOCATED AT APT 2E, 2nd STORY, 1st APARTMENT FROM NORTH AT EAST";
  check(
    withoutUnit(door) === "§ 27-2005, 27-2007, 27-2041.1 HMC, §238, § 309; § 107 (2) ( C) MDL AND 28 RCNY §25-171: REPLACE OR REPAIR THE SELF-CLOSING DOORS THAT IS MISSING OR DEFECTIVE HINGES IN THE ENTRANCE [apartment withheld]",
    "unit: the apartment, its floor and its place on the floor go together; the condition stays in the city's words",
  );
  const mould =
    "§ 27-2017.3 HMC: TRACE AND REPAIR THE SOURCE AND ABATE THE VISIBLE MOLD CONDITION... LESS THAN 10 SQ FT OBSERVED AT CEILING AND EAST WALL IN THE BATHROOM LOCATED AT APT 4N, 4th STORY, 2nd APARTMENT FROM EAST AT SOUTH , SECTION ''760''";
  check(withoutUnit(mould).endsWith("IN THE BATHROOM [apartment withheld]"), "unit: a SECTION after the clause goes with it");
  const cellar = "HMC ADM CODE: § 27-2017.4 ABATE THE INFESTATION CONSISTING OF MICE IN THE ENTIRE APARTMENT LOCATED AT CELLAR APT B6, 1st CELLAR APT FROM NORTH AT EAST , SECTION ''730 ROGERS''";
  check(withoutUnit(cellar) === "HMC ADM CODE: § 27-2017.4 ABATE THE INFESTATION CONSISTING OF MICE IN THE ENTIRE APARTMENT [apartment withheld]", "unit: a cellar apartment, and IN THE ENTIRE APARTMENT is kept");
  const basement =
    "§ 27-2017.3 HMC: TRACE AND REPAIR THE SOURCE AND ABATE THE VISIBLE MOLD CONDITION... APPROX. 10 SQ. FT. AT THE NORTH WALL AND WEST WALL IN THE BATHROOM LOCATED AT BSMT-APT B2, 1st BSMT-APT FROM EAST AT SOUTH ORIGINAL VIOLATION 13147909 ISSUED 28-JUN-19 HAS BEEN UPGRADED TO CLASS C PER ADMINISTRATIVE CODE §27-2017.3a(5)(a) or (b).";
  check(
    withoutUnit(basement).endsWith("IN THE BATHROOM [apartment withheld] ORIGINAL VIOLATION 13147909 ISSUED 28-JUN-19 HAS BEEN UPGRADED TO CLASS C PER ADMINISTRATIVE CODE §27-2017.3a(5)(a) or (b).") && !/B2\b/.test(withoutUnit(basement)),
    "unit: a basement apartment goes, and the city's note after it that the violation was upgraded stays",
  );
  const room = "§ 27-2026, 2027 HMC: PROPERLY REPAIR THE SOURCE AND ABATE THE EVIDENCE OF A WATER LEAK CEILING & NORTH WALL IN THE BATHROOM LOCATED AT B-ROOM 1X, 1st STORY, 1st B-ROOM FROM NORTH AT EAST";
  check(withoutUnit(room).endsWith("IN THE BATHROOM [apartment withheld]"), "unit: a rooming unit is a home too");
  const older = "§ 27-2018 ADMIN. CODE: ABATE THE NUISANCE CONSISTING OF MICE AT ENTIRE APARTMENT, 4th STORY, APARTMENT, SECTION ''1997'', 1st FROM EAST AT SOUTH";
  check(withoutUnit(older) === "§ 27-2018 ADMIN. CODE: ABATE THE NUISANCE CONSISTING OF MICE AT ENTIRE APARTMENT [apartment withheld]", "unit: the form with no LOCATED AT, a floor and APARTMENT, goes whole");
  const oldest = "SECTION 27-2005 ADM CODE PROPERLY REPAIR WITH SIMILAR MATERIAL THE BROKEN OR DEFECTIVE CERAMIC FLOOR TILE 5 STY NORTHEAST APT L4. , SECTION '' ''";
  check(withoutUnit(oldest) === "SECTION 27-2005 ADM CODE PROPERLY REPAIR WITH SIMILAR MATERIAL THE BROKEN OR DEFECTIVE CERAMIC FLOOR TILE APT [unit]. , SECTION '' ''", "unit: the oldest form names it mid-sentence; the unit and its floor go");
  // A unit with no number is a unit too: the apartment column holds PH.
  check(withoutUnit(oldest.replace("APT L4", "APT PH")) === withoutUnit(oldest), "unit: after a floor, a unit with no number goes as L4 does");
  const lock =
    "SECTION 27-2005 ADM CODE PROPERLY REPAIR THE BROKEN OR DEFECTIVE MORTISE LOCK AT APT. ENTRANCE DOOR IN THE FOYER LOCATED AT APT 4I, 4th STORY, 1st APARTMENT FROM NORTH AT EAST , SECTION ''WEST''";
  check(withoutUnit(lock) === "SECTION 27-2005 ADM CODE PROPERLY REPAIR THE BROKEN OR DEFECTIVE MORTISE LOCK AT APT. ENTRANCE DOOR IN THE FOYER [apartment withheld]", "unit: APT. ENTRANCE DOOR names no unit and stays");
  const hall = "§ 27-2005 HMC: PROPERLY REPAIR OR REPLACE THE BROKEN OR DEFECTIVE LATCH SET AND ASSEMBLY AT COMPACTOR CLOSERT AT 1 STY AT PUBLIC HALL, 1st STORY";
  check(withoutUnit(hall) === hall, "unit: a public hall and its floor are nobody's home, and nothing goes");
  const entrance = "§ 27-2005 HMC: PROPERLY REPAIR OR REPLACE THE BROKEN OR DEFECTIVE MORTISE LOCK AND ASSEMBLY AT BUILDING ENTRANCE DOOR FROM STREET TO 1ST STORY LOCATED AT PUBLIC PARTS 1E, 1st STORY";
  check(withoutUnit(entrance).endsWith("LOCATED AT PUBLIC PARTS, 1st STORY"), "unit: a public part keeps its place and loses the unit it was filed under");
  check(withoutUnit(withoutUnit(door)) === withoutUnit(door), "unit: taking it out twice is taking it out once");

  // The preview is drawn from the receipt, whose line for a repair cuts the
  // city's words at 220 characters, often inside the clause.
  const shared = (description: string) =>
    buildingReceipt("155 Linden Boulevard", "3050840061", "155 LINDEN BOULEVARD, Brooklyn", [{ status: "NOV CERTIFIED ON TIME", date: "2026-09-17", hazardClass: "B", certifiedBy: "2026-09-17", description }], { versionsSince: "2026-08-29" })
      .blocks[0].slice(0, 3)
      .map(withoutUnit)
      .join(" ");
  const cut = shared(door);
  check(door.length > 220 && cut.startsWith("NOV CERTIFIED ON TIME on 2026-09-17 (class B)") && !/\bAPT\b|STORY|FROM NORTH/.test(cut), `unit: a line cut inside the clause shows none of it (…${cut.slice(-40)})`);
  // The oldest form, lengthened at its start so the cut lands on each
  // character from the end of its floor to the end of its unit.
  const from = oldest.indexOf("5 STY") + "5 STY".length;
  const to = oldest.indexOf("L4") + "L4".length;
  const leaks = Array.from({ length: to - from + 1 }, (_, i) => shared(" ".repeat(217 - (from + i)) + oldest)).filter((s) => !/FLOOR TILE(?: APT \[unit\])?…$/.test(s) || /\bSTY\b|NORTH|EAST/.test(s));
  check(to - from > 10 && leaks.length === 0, `unit: a line cut anywhere in the oldest form after its floor shows neither the floor nor the unit${leaks.length ? ` (…${leaks[0].slice(-40)})` : ""}`);

  // Every row in HPD's file on disk: no in-unit row keeps its unit, its floor
  // or its place on the floor; every other row is left exactly as it was. And
  // the separate apartment and story columns are not kept at all.
  const held: Record<string, string | undefined>[] = JSON.parse(readFileSync(join(dir, "nyc-hpd-certs.json"), "utf8"));
  const inUnit = held.filter((r) => r.apartment);
  const flat = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim();
  check(
    inUnit.length > 0 && inUnit.every((r) => !withoutUnit(flat(r.novdescription)).includes(`APT ${r.apartment}`) && !/\d+(?:st|nd|rd|th) STORY|APARTMENT FROM/i.test(withoutUnit(flat(r.novdescription)))),
    `unit: none of the ${inUnit.length} in-unit rows on disk keeps its unit, floor or position`,
  );
  check(held.filter((r) => !r.apartment).every((r) => withoutUnit(flat(r.novdescription)) === flat(r.novdescription)), "unit: every other row on disk is left as the city wrote it");
  const kept = adapters["nyc-hpd"].normalise(inUnit[0]);
  check(!("apartment" in kept) && !("story" in kept) && String(kept.novdescription).includes(`APT ${inUnit[0].apartment}`), "unit: the apartment and story columns are dropped; the city's description, which names the unit, is kept");
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
