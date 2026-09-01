/**
 * Matching, intent and receipt rendering on today's real file.
 *   npx tsx scripts/receipt-test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { nyWarn } from "../engine/adapters/nyWarn";
import { scoreCompany, scoreAddress, mentionsCompany, companyMentionScore } from "../engine/match";
import { classifyInbound } from "../engine/intent";
import { layoffReceipt, receiptText, type LayoffNoticeRow } from "../engine/receipt";

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

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
