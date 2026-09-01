import { mdWarn } from "../engine/adapters/mdWarn";
import { warnNoticeGap } from "../engine/rules";

// Reads Maryland's real page and asserts on what actually comes back. Run:
//   npx tsx scripts/md-test.ts

const UA = "Notice/0.1 (+https://github.com/N-45div/notice; keeps dated copies of public filings)";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const t = mdWarn.transport;
if (t.kind !== "http_text") throw new Error("expected http_text");

const res = await fetch(t.url, { headers: { "User-Agent": UA, Accept: "*/*" } });
const text = await res.text();
console.log(`\n== ${mdWarn.id}  ${res.status}  ${text.length} bytes`);

const rows = mdWarn.parse({ kind: "text", text, status: res.status, url: t.url, fetchedAt: new Date().toISOString() });
ok("parsed some rows", rows.length > 0, `${rows.length} rows`);
ok("every row has a company", rows.every((r) => r.Company.length > 0));

const identities = rows.map((r) => mdWarn.identity(r));
ok("identities are unique", new Set(identities).size === identities.length, `${new Set(identities).size} of ${identities.length}`);
ok("identities are stable across a re-parse", mdWarn.identity(rows[0]) === identities[0]);

const fields = rows.map((r) => mdWarn.normalise(r));
const iso = /^\d{4}-\d{2}-\d{2}$/;
ok("notice dates are ISO", fields.every((f) => iso.test(String(f.noticeDate))));
ok(
  "effective dates are ISO or empty",
  fields.every((f) => f.effectiveDate === "" || iso.test(String(f.effectiveDate))),
);
ok("worker counts are numbers", fields.every((f) => typeof f.employeesAffected === "number" && !Number.isNaN(f.employeesAffected)));
ok("no cell kept a newline", fields.every((f) => !String(f.siteAddress).includes("\n") && !String(f.company).includes("\n")));

const ranges = fields.filter((f) => f.effectiveDateEnd);
ok("ranges keep both ends", ranges.length === 0 || ranges.every((f) => iso.test(String(f.effectiveDateEnd))), `${ranges.length} ranges`);

const prose = fields.filter((f) => String(f.workersRaw) !== String(f.employeesAffected));
console.log(`  note  ${prose.length} rows where the worker cell was not a bare number`);
for (const f of prose.slice(0, 3)) console.log(`        "${f.workersRaw}" → ${f.employeesAffected}`);

const usable = fields.filter((f) => iso.test(String(f.noticeDate)) && iso.test(String(f.effectiveDate)));
const gaps = usable.map((f) =>
  warnNoticeGap({ jurisdiction: "US-MD", noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate) }),
);
const short = gaps.filter((g) => g.verdict === "gap");
console.log(`\n  MD: ${short.length}/${gaps.length} under the 60-day statute`);
const worst = usable
  .map((f, i) => ({ f, g: gaps[i] }))
  .sort((a, b) => a.g.actualDays - b.g.actualDays)[0];
if (worst) console.log(`  shortest: ${worst.f.company} — ${worst.g.actualDays} days (${worst.f.noticeDate} → ${worst.f.effectiveDate})`);

console.log(`\n  sentence: ${mdWarn.render(fields[0])}`);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
