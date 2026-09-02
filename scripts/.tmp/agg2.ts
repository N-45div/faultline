import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vaWarn } from "../../engine/adapters/vaWarn";
import { aggregationLine, layoffReceipt, receiptText, type LayoffNoticeRow } from "../../engine/receipt";
import { foldString } from "../../engine/canon";

const dir = join("data", "snapshots", "2026-08-29T140311Z");
const raw = vaWarn.parse({ kind: "text", text: readFileSync(join(dir, "va-warn.csv"), "utf8"), status: 200, url: "f", fetchedAt: "" });
const all: LayoffNoticeRow[] = raw.map((r: any) => {
  const f = vaWarn.normalise(r);
  return { company: String(f.company), siteAddress: String(f.siteAddress), workers: Number(f.employeesAffected) || 0,
    noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate), postedDate: "", jurisdiction: "US-VA",
    layoffOrClosure: String(f.layoffOrClosure) } as LayoffNoticeRow;
});
const of = (name: string) => all.filter((r) => foldString(r.company) === foldString(name));

for (const name of ["Cumberland River Coal Company", "Wellmore Energy Company LLC", "Genetworx"]) {
  const rows = of(name);
  console.log(`\n=== ${name}: ${rows.length} rows`);
  for (const r of rows) console.log(`   ${r.noticeDate} | ${r.effectiveDate} | ${r.workers.toString().padStart(4)} | ${r.siteAddress} | ${r.layoffOrClosure}`);
  for (const r of rows) { const l = aggregationLine(r, rows); if (l) console.log(`   -> ${r.noticeDate} ${r.siteAddress} (${r.workers}): ${l.split(".")[0]}.`); }
}
// statewide
const statewide = all.filter((r) => /statewide/i.test(r.siteAddress));
console.log(`\n=== statewide rows: ${statewide.length}`);
for (const r of statewide) console.log(`   ${r.company} | ${r.noticeDate} | ${r.workers} | ${r.siteAddress}`);
