/**
 * Matching, intent and receipt rendering on today's real file.
 *   npx tsx scripts/receipt-test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { nyWarn } from "../engine/adapters/nyWarn";
import { scoreCompany, scoreAddress, mentionsCompany, companyMentionScore, sameCompany, searchTerms } from "../engine/match";
import { classifyInbound } from "../engine/intent";
import { aggregationLine, amendmentLines, buildingReceipt, exceptionLine, layoffReceipt, noMatchReceipt, receiptText, startDateIsCertain, type LayoffNoticeRow } from "../engine/receipt";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

console.log("== company matching");
const pairs: [string, string, number][] = [
  ["Meta", "Meta Platforms, Inc.", 0.8],
  ["Spirit Airlines", "Spirit Airlines, LLC", 0.99],
  ["spirit", "Spirit Airlines, LLC", 0.8],
  ["Bush", "Bush Industries Inc. d/b/a eSolutions Group", 0.7],
  ["McDonalds", "McDonald's Corporation", 0.8],
  ["Genentech", "Genentech, Inc.", 0.99],
  ["Google", "Meta Platforms, Inc.", 0],
];
for (const [q, label, min] of pairs) {
  const s = scoreCompany(q, label);
  check(s >= min && (min > 0 || s === 0), `"${q}" vs "${label}" → ${s.toFixed(2)} (want ≥ ${min})`);
}

check(searchTerms("Martin's") === "martin s", `index terms for Martin's: ${searchTerms("Martin's")}`);
check(searchTerms("McDonalds") === "mcdonalds mcdonald", "a possessive typed without its apostrophe carries its stem");
check(searchTerms("Spirit Airlines, LLC") === "spirit airlines airline", "legal words dropped, plural stem added");

check(sameCompany("Spirit Airlines", "Spirit Airlines, LLC"), "a legal suffix does not make a second employer");
check(sameCompany("McDonald's Corporation", "McDonalds Corp"), "nor does an apostrophe or an abbreviation");
check(!sameCompany("Amazon", "Amazon Web Services"), "but a different company is a different company");
check(!sameCompany("", "Anything"), "an empty name matches nothing");

console.log("== address matching");
check(scoreAddress("249 East 37 St, Brooklyn", "249 EAST 37 STREET, Brooklyn") >= 0.9, "249 East 37 St → 249 EAST 37 STREET");
check(scoreAddress("1072 Woodycrest Ave", "1072 WOODYCREST AVENUE, Bronx") >= 0.9, "1072 Woodycrest Ave → 1072 WOODYCREST AVENUE");
check(scoreAddress("250 East 37 St", "249 EAST 37 STREET, Brooklyn") === 0, "wrong house number → 0");

console.log("== intent");
check(classifyInbound("Spirit Airlines", "").kind === "lookup", "subject only → lookup");
check(classifyInbound("Fwd: Re: Spirit Airlines", "").kind === "lookup", "Fwd/Re stripped → lookup");
check(classifyInbound("", "Meta\n\nSent from my phone").kind === "lookup", "first line of body → lookup");
check(classifyInbound("follow", "").kind === "follow", "follow");
check(classifyInbound("Re: your receipt", "FOLLOW\n\n> On Aug 29 ...").kind === "follow", "FOLLOW as reply body → follow");
check(classifyInbound("stop", "").kind === "stop", "stop");
const letter = "Dear Dana,\n\nWe regret to inform you that your position with USIC Locating Services has been eliminated effective April 6, 2026 due to a contract loss. Your severance agreement is attached and must be signed within 21 days. Your last day is April 6. Please return all company property. This decision is specific to your role and is not a reflection of your performance.\n\nHuman Resources";
check(classifyInbound("Fwd: Separation notice", letter).kind === "letter", "a real letter → letter");
check(mentionsCompany(letter, "USIC Locating Services, LLC. d/b/a Reconn Utility Services") === false, "full d/b/a name not all present");
check(mentionsCompany(letter, "USIC Locating Services"), "short name present");
check(companyMentionScore(letter, "USIC Locating Services, LLC. d/b/a Reconn Utility Services") >= 0.6, "mention score finds the d/b/a company from a letter");
check(companyMentionScore(letter, "Meta Platforms, Inc.") === 0, "mention score ignores an unmentioned company");

console.log("== receipt from today's NY file");
const dir = join("data", "snapshots", readdirSync(join("data", "snapshots")).sort().at(-1)!);
const rows = nyWarn.parse({ kind: "text", text: readFileSync(join(dir, "ny-warn.csv"), "utf8"), status: 200, url: "fixture", fetchedAt: "" });
const spirit: LayoffNoticeRow[] = rows
  .filter((r) => scoreCompany("Spirit Airlines", r["Business Legal Name"]) >= 0.8)
  .map((r) => {
    const f = nyWarn.normalise(r);
    return {
      company: String(f.company), siteAddress: String(f.siteAddress), workers: Number(f.employeesAffected),
      noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate), postedDate: String(f.postedDate),
      jurisdiction: "US-NY", layoffOrClosure: String(f.layoffOrClosure), reason: String(f.reason),
    };
  });
check(spirit.length >= 1, `Spirit Airlines rows in file: ${spirit.length}`);
const receipt = layoffReceipt("Spirit Airlines", "x", spirit, { versionsSince: "2026-08-29", pageUrl: "https://example.convex.site/e/spirit-airlines" });
const text = receiptText(receipt);
console.log("\n" + text.split("\n").map((l) => "    " + l).join("\n") + "\n");
// A notice dated the day the layoff began now says so in words: "0 days'
// notice" was arithmetic, and a notice dated afterwards read as "-37 days'".
check(/Dated the day the layoff began\. New York's WARN Act sets 90 days\./.test(text), "receipt states the 0-day gap against the 90-day statute");
check(!/-\d+ days?' notice/.test(text), "no negative day count reaches the copy");
check(!/\b(source|adapter|snapshot|diff|monitor|crawl|webhook|watch)\b/i.test(text), "receipt copy passes the ban list");

// An employer that filed in two states must name both, count filings (not
// distinct addresses), and link to both states' pages.
{
  const two = layoffReceipt(
    "Crothall Healthcare",
    "x",
    [
      { company: "Crothall Healthcare", siteAddress: "Richmond VA", workers: 545, noticeDate: "2026-08-28", effectiveDate: "2026-10-31", postedDate: "", jurisdiction: "US-VA", layoffOrClosure: "Closure" },
      { company: "Crothall Healthcare", siteAddress: "Richmond VA", workers: 139, noticeDate: "2018-11-15", effectiveDate: "2019-01-20", postedDate: "", jurisdiction: "US-VA", layoffOrClosure: "Layoff" },
      { company: "Crothall Healthcare", siteAddress: "100 E. Carroll St Salisbury, MD 21801", workers: 109, noticeDate: "2026-04-29", effectiveDate: "2026-07-01", postedDate: "", jurisdiction: "US-MD", layoffOrClosure: "Mass Layoff - No Recall" },
    ],
    { versionsSince: "2026-08-29" },
  );
  const t = receiptText(two);
  check(/3 filings in Virginia and Maryland, 793 workers, 2018–2026/.test(two.headline), `two-state headline: ${two.headline}`);
  check(/Virginia · Richmond VA — 545 workers/.test(t) && /Maryland · 100 E\. Carroll St/.test(t), "each block names its state");
  check(/Check it on Virginia's page/.test(t) && /Check it on Maryland's page/.test(t), "one link per state present");
  check(!/1 workers/.test(t), "no '1 workers'");
  // Virginia has no WARN act of its own; naming one would invent a law.
  check(/inside the 60 days federal WARN sets/.test(t), "the statute is named by whoever wrote it");
  check(!/Virginia's WARN Act/.test(t) && !/days Virginia sets/.test(t), "no state act is invented for Virginia");
  const short = receiptText(
    layoffReceipt("X", "x", [{ company: "X", siteAddress: "Richmond VA", workers: 60, noticeDate: "2026-05-01", effectiveDate: "2026-05-15", postedDate: "", jurisdiction: "US-VA" }], { versionsSince: "2026-08-29" }),
  );
  check(/federal WARN sets 60 days; Virginia has no WARN act of its own\./.test(short), "a state without an act gets the federal rule, said plainly");
  const ny = receiptText(
    layoffReceipt("Y", "y", [{ company: "Y", siteAddress: "1 Main St", workers: 60, noticeDate: "2026-05-01", effectiveDate: "2026-05-15", postedDate: "", jurisdiction: "US-NY" }], { versionsSince: "2026-08-29" }),
  );
  check(/New York's WARN Act sets 90 days\./.test(ny) && !/has no WARN act/.test(ny), "a state that has one is named by it");
}

// Separate filings at one site inside 90 days are one event under the federal
// rule; the state's file shows them as unrelated rows. Martin's, Richmond, 2017.
{
  // The federal rule aggregates at a single site of employment, so this only
  // fires where the state publishes a street address.
  const site = (noticeDate: string, workers: number, effectiveDate: string): LayoffNoticeRow => ({
    company: "Martin's", siteAddress: "155 South Hill Drive, Richmond VA", workers, noticeDate, effectiveDate, postedDate: "", jurisdiction: "US-VA", layoffOrClosure: "Layoff",
  });
  const rows = [site("2017-04-11", 138, "2017-07-10"), site("2017-04-11", 99, "2017-07-10"), site("2017-04-24", 109, "2017-06-23"), site("2016-12-08", 155, "2017-02-06"), site("2016-06-14", 96, "2016-08-13")];
  const third = aggregationLine(rows[2], rows) ?? "";
  check(/^3rd notice at this address in 13 days; 346 workers across them\./.test(third), `aggregation: ${third}`);
  check(/^One of 2 notices at this address dated the same day, 237 workers together\./.test(aggregationLine(rows[0], rows) ?? ""), "same-day filings are counted, not ranked");
  check(aggregationLine(rows[4], rows) === null, "a filing with nothing inside 90 days says nothing");
  check(aggregationLine(rows[3], rows) === null, "December's filing is outside April's window, and June's is outside December's");
  const other = { ...rows[2], siteAddress: "8 Granby Street, Norfolk VA" };
  check(aggregationLine(other, [...rows, other]) === null, "another address is another site");
  // Colorado publishes a workforce area, not a site. Two notices in "Pueblo"
  // are not evidence of one aggregated layoff, and must not claim to be.
  const region = rows.map((r) => ({ ...r, siteAddress: "Pueblo", jurisdiction: "US-CO" as const }));
  check(aggregationLine(region[2], region) === null, "a workforce area is not a site of employment");
  check(aggregationLine({ ...rows[2], noticeDate: "2017-07-10" }, [{ ...rows[0], noticeDate: "2017-04-11" }]) === null, "exactly 90 days apart spans 91 days, so it is outside the window");
  const t = receiptText(layoffReceipt("Martin's", "x", rows, { versionsSince: "2026-08-29" }));
  check(/3rd notice at this address in 13 days/.test(t) && /within any 90-day period together/.test(t), "the receipt carries the aggregation line");
}

// Short notice: the rule allows it only for a named exception and the notice
// must state the basis. Say what the state's file records, and whether those
// words name an exception. Never a verdict.
{
  const ny = (reason: string | undefined): LayoffNoticeRow => ({
    company: "X", siteAddress: "1 Main St", workers: 60, noticeDate: "2026-05-01", effectiveDate: "2026-05-15", postedDate: "", jurisdiction: "US-NY", reason,
  });
  const gap = { verdict: "gap" as const, jurisdiction: "US-NY" };
  check(
    exceptionLine(ny("Economic"), gap) ===
      'The reason New York recorded, "Economic", names none of the exceptions the rule allows for shorter notice (faltering company, unforeseeable business circumstances, natural disaster or strike or lockout).',
    "a reason that names no exception",
  );
  check(/names the "unforeseeable business circumstances" exception\. The rule also requires the notice to state the basis/.test(exceptionLine(ny("Unforeseen Business Circumstances"), gap) ?? ""), "a reason that names one");
  check(/^New York's file records no reason\. The rule allows shorter notice only for/.test(exceptionLine(ny(undefined), gap) ?? ""), "no reason recorded");
  check(/^Colorado's file records no reason \("Not Specified"\)\./.test(exceptionLine({ ...ny("Not Specified"), jurisdiction: "US-CO" }, { verdict: "gap", jurisdiction: "US-CO" }) ?? ""), "'Not Specified' is no reason");
  check(exceptionLine(ny("Economic"), { verdict: "within", jurisdiction: "US-NY" }) === null, "nothing to say when notice was within the statute");
  // A filing below the federal headcount gets the threshold, not a verdict.
  const small = receiptText(
    layoffReceipt("Z", "z", [{ company: "Z", siteAddress: "1 Main St", workers: 13, noticeDate: "2026-05-04", effectiveDate: "2026-05-02", postedDate: "", jurisdiction: "US-MD" }], { versionsSince: "2026-08-29" }),
  );
  check(/13 workers — below the 50 the federal act normally requires notice for at one site\./.test(small), "a sub-threshold filing says so");
  check(!/records no reason\. The rule allows shorter notice only for/.test(small), "and is not given the exception paragraph");
  // A word inside a reason is not a legal exception. Colorado writes free text.
  const co = (reason: string) => exceptionLine({ ...ny(reason), jurisdiction: "US-CO" }, { verdict: "gap", jurisdiction: "US-CO" }) ?? "";
  check(/names none of the exceptions/.test(co("Natural gas plant shutdown")), "'natural gas' does not name the natural-disaster exception");
  check(/names none of the exceptions/.test(co("Physical inventory consolidation")), "'physical inventory' does not name a physical calamity");
  check(/names the "natural disaster" exception/.test(co("Closure after flood damage")), "but a flood does");
  check(/names the "faltering company" exception/.test(co("Faltering company, financing withdrawn")), "and a faltering company does");
}

// New Jersey publishes the month it posted a notice and never the day, so no
// notice period can be counted from its file. The receipt must say that and
// never put a number there — and a filing we cannot count must not sort as if
// it were the worst one.
{
  const nj: LayoffNoticeRow = {
    company: "Bristol Myers Squibb", siteAddress: "Lawrence Twp NJ", workers: 67, noticeDate: "", noticeMonth: "2025-02",
    effectiveDate: "2025-04-24", postedDate: "", jurisdiction: "US-NJ",
  };
  const one = receiptText(layoffReceipt("Bristol Myers Squibb", "x", [nj], { versionsSince: "2026-08-29" }));
  check(/Posted by New Jersey in February 2025\. Layoff started 2025-04-24\./.test(one), "the month is shown, and no day is invented");
  check(
    /New Jersey publishes the month it posted a notice, not the date the employer gave it, so the notice period cannot be counted from the state's file\. New Jersey's own WARN Act sets 90 days, and since April 2023 severance of a week per year worked\./.test(one),
    "the rule is named and never scored",
  );
  // "90 days" is the statute and belongs here; a count of notice GIVEN does not.
  check(!/days' notice/.test(one) && !/Dated the day the layoff began/.test(one) && !/-\d+ day/.test(one), "no notice count reaches a New Jersey receipt");
  check(!/Notice dated \./.test(one) && !/Notice dated \s*$/m.test(one), "no empty 'Notice dated' line");
  // Mixed states: the uncountable filing must not sort above a real short-notice one.
  const ny: LayoffNoticeRow = {
    company: "Bristol Myers Squibb", siteAddress: "1 Main St", workers: 40, noticeDate: "2026-05-01", effectiveDate: "2026-05-15",
    postedDate: "", jurisdiction: "US-NY", reason: "Economic",
  };
  const both = layoffReceipt("Bristol Myers Squibb", "x", [nj, ny], { versionsSince: "2026-08-29" });
  const t = receiptText(both);
  check(t.indexOf("14 days' notice") < t.indexOf("New Jersey publishes the month"), "a countable short notice sorts above an uncountable one");
  // Said once per state, however many of that state's filings are shown.
  const many = receiptText(layoffReceipt("Bristol Myers Squibb", "x", [nj, { ...nj, siteAddress: "Plainsboro NJ", effectiveDate: "2025-06-01" }, { ...nj, siteAddress: "Princeton NJ", effectiveDate: "2025-07-01" }], { versionsSince: "2026-08-29" }));
  check((many.match(/publishes the month it posted a notice/g) ?? []).length === 1, "the explanation is given once, not once per filing");
  check((many.match(/Posted by New Jersey in February 2025/g) ?? []).length === 3, "but every filing still says which month it was posted");
  check(/2 filings in New Jersey and New York, 107 workers, 2025–2026/.test(both.headline), `mixed headline: ${both.headline}`);
  check(/Check it on New Jersey's page/.test(t), "New Jersey's own page is linked");
}

// A start-date cell holding more than one date is the state saying more than
// one thing. Maryland writes ranges backwards; New Jersey writes lists.
{
  check(startDateIsCertain("03/31/2026"), "one date is certain");
  check(startDateIsCertain(undefined) && startDateIsCertain(""), "no cell is certain");
  check(startDateIsCertain("10/23/2026 - 03/26/2027"), "a range in order is certain: its start is the first date");
  check(!startDateIsCertain("03/31/2026 - 06/30/2025"), "a range written backwards is not");
  check(!startDateIsCertain("3/31/26 (Paramus and Ramsey), 4/30/26 (Livingston)"), "a list of sites and dates is not");
  check(!startDateIsCertain("1/31/25 and 2/3/25"), "two dates joined by 'and' are not a range");

  const md: LayoffNoticeRow = {
    company: "MUFG Investor Services", siteAddress: "805 King Farm Boulevard, Rockville, MD 20850", workers: 86,
    noticeDate: "2026-01-30", effectiveDate: "2026-03-31", effectiveDateRaw: "03/31/2026 - 06/30/2025", postedDate: "", jurisdiction: "US-MD",
  };
  const t = receiptText(layoffReceipt("MUFG", "x", [md], { versionsSince: "2026-08-29" }));
  check(/Maryland's file gives the start as "03\/31\/2026 - 06\/30\/2025"\./.test(t), "the cell is shown as written");
  check(/The notice period cannot be counted while the start date is written this way\./.test(t), "and no period is counted from it");
  check(!/inside the 60 days/.test(t) && !/days' notice/.test(t), "a backwards range never reads as compliant");
  check(/Notice dated 2026-01-30\./.test(t), "the notice date, which the state did give, is still shown");
}

// A building with live violations is not "no stamps": count them by class,
// in the city's own words, and name the stamps only when there are some.
{
  const b = buildingReceipt("773 Concourse Village East", "2024430170", "773 CONCOURSE VILLAGE EAST, Bronx", [
    { status: "NOV SENT OUT", date: "2026-08-31", hazardClass: "B", certifiedBy: null, violationId: "1", description: "§ 27-2005 ADM CODE REPAIR THE BROKEN OR DEFECTIVE PLASTERED SURFACES" },
    { status: "NOV SENT OUT", date: "2026-08-31", hazardClass: "C", certifiedBy: null, violationId: "2", description: "§ 27-2026 ADM CODE PROVIDE HOT WATER" },
    { status: "VIOLATION OPEN", date: "2026-08-30", hazardClass: "A", certifiedBy: null, violationId: "3", description: null },
  ], { versionsSince: "2026-08-29", held: { rows: 3, versions: 4, reads: 41, since: Date.UTC(2026, 7, 29) }, provenance: [{ publisher: "New York City", url: "https://data.cityofnewyork.us/resource/wvxf-dwi5.json", at: Date.UTC(2026, 8, 2, 3, 12), status: 200, rows: 3382, lastChecked: Date.UTC(2026, 8, 2, 3, 12) }] });
  const t = receiptText(b);
  check(/3 violations on record \(1 class C, 1 class B, 1 class A\)\./.test(b.headline), `building headline: ${b.headline}`);
  check(!/no certification stamps/.test(b.headline), "never 'no stamps' over live violations");
  check(/PROVIDE HOT WATER/.test(t), "the city's own description is in the receipt");
  check(t.indexOf("class C") < t.indexOf("class B"), "class C shown before class B");
  check(/We hold 3 rows for this, in 4 versions, across 1 file read 41 times between them since 2026-08-29\./.test(t), "the held line counts, and names how many files");
  check(/Read from New York City's file on 2026-09-02 03:12 UTC \(HTTP 200, 3,382 rows\)/.test(t), "the provenance line is dated");
}

// The amendment chain: a state moved a start date in place. Both values, the
// day we caught it, the kept version, and the federal rule beside it.
{
  const lines = amendmentLines({
    at: Date.UTC(2026, 8, 5),
    changed: ["effectiveDate"],
    before: { effectiveDate: "2026-10-31", employeesAffected: 545 },
    after: { effectiveDate: "2027-01-15", employeesAffected: 545 },
  });
  check(/Amended by the state: the layoff start date from 2026-10-31 to 2027-01-15\. We saw the change on 2026-09-05; the version before it is kept\./.test(lines[0] ?? ""), `amendment line: ${lines[0]}`);
  check(/The start moved 76 days later\. Federal rules say a postponement of more than 60 days needs a fresh notice; whether one was given is a question for a lawyer\./.test(lines[1] ?? ""), `postponement line: ${lines[1]}`);
  check(amendmentLines({ at: 0, changed: ["county"], before: { county: "Howard" }, after: { county: "Howard County" } }).length === 0, "a change nobody cares about says nothing");
  const withAmend = layoffReceipt("Crothall", "x", [{ company: "Crothall Healthcare", siteAddress: "Richmond VA", workers: 545, noticeDate: "2026-08-28", effectiveDate: "2027-01-15", postedDate: "", jurisdiction: "US-VA", amendments: [{ at: Date.UTC(2026, 8, 5), changed: ["effectiveDate"], before: { effectiveDate: "2026-10-31" }, after: { effectiveDate: "2027-01-15" } }] }], { versionsSince: "2026-08-29" });
  check(/Amended by the state/.test(receiptText(withAmend)), "the receipt carries the amendment");
}

// Nothing filed is an answer: dated, per file, followable.
{
  const none = noMatchReceipt("Initech", [], {
    at: Date.UTC(2026, 8, 3, 1, 0),
    followKey: "q:initech",
    provenance: [
      { publisher: "New York", url: "u", at: 1, status: 200, rows: 193, lastChecked: Date.UTC(2026, 8, 2, 18, 30) },
      { publisher: "Virginia", url: "u", at: 1, status: 200, rows: 1123, lastChecked: Date.UTC(2026, 8, 2, 20, 0) },
    ],
  });
  const t = receiptText(none);
  check(/As of 2026-09-03 01:00 UTC, "Initech" appears in none of the files we hold/.test(t), "the absence is dated");
  check(/— Virginia: 2026-09-02 20:00 UTC \(1,123 rows\)/.test(t), "each file's last read is listed");
  check(none.subjectKey === "q:initech" && /Reply FOLLOW and we'll email you if a notice under this name appears/.test(t), "the absence can be followed");
  check((t.match(/Reply FOLLOW/g) ?? []).length === 1, "and is asked to follow only once");
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
