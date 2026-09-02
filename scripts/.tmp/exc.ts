import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { coWarn } from "../../engine/adapters/coWarn";
import { exceptionLine, type LayoffNoticeRow } from "../../engine/receipt";
import { warnNoticeGap } from "../../engine/rules";
const dir = join("data", "snapshots", "2026-08-29T140311Z");
for (const [a, file, j] of [[nyWarn, "ny-warn.csv", "US-NY"], [coWarn, "co-warn.csv", "US-CO"]] as any[]) {
  const rows = a.parse({ kind: "text", text: readFileSync(join(dir, file), "utf8"), status: 200, url: "f", fetchedAt: "" });
  const out = new Map<string, number>();
  for (const r of rows) {
    const f = a.normalise(r);
    const row: LayoffNoticeRow = { company: String(f.company), siteAddress: String(f.siteAddress), workers: Number(f.employeesAffected) || 0,
      noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate), postedDate: "", jurisdiction: j, reason: f.reason ? String(f.reason) : undefined };
    const g = warnNoticeGap({ jurisdiction: j, noticeDate: row.noticeDate, effectiveDate: row.effectiveDate });
    const l = exceptionLine(row, g);
    if (l) out.set(l, (out.get(l) ?? 0) + 1);
  }
  console.log(`\n=== ${a.id}: ${[...out.values()].reduce((x,y)=>x+y,0)} exception lines, ${out.size} distinct`);
  for (const [l, n] of [...out.entries()].sort((x,y)=>y[1]-x[1])) console.log(`   ${n}x  ${l}`);
}
