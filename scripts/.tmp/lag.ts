import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { caWarn } from "../../engine/adapters/caWarn";
import { warnNoticeGap } from "../../engine/rules";
import { daysBetween } from "../../engine/canon";

const dir = join("data", "snapshots", "2026-08-29T140311Z");

// NY
{
  const rows = nyWarn.parse({ kind: "text", text: readFileSync(join(dir, "ny-warn.csv"), "utf8"), status: 200, url: "f", fetchedAt: "" });
  const f = rows.map((r) => nyWarn.normalise(r));
  const neg = f.filter((x) => x.postedDate && daysBetween(String(x.noticeDate), String(x.postedDate)) < 0);
  const zero = f.filter((x) => x.postedDate && daysBetween(String(x.noticeDate), String(x.postedDate)) === 0);
  console.log(`NY: ${f.length} rows; posted-before-notice: ${neg.length}; posted-same-day: ${zero.length}`);
  for (const x of neg.slice(0, 5)) console.log("   neg:", x.company, x.noticeDate, "->", x.postedDate, daysBetween(String(x.noticeDate), String(x.postedDate)));
  for (const x of zero.slice(0, 2)) console.log("   zero:", x.company, x.noticeDate, "->", x.postedDate);
  // worker counts
  const negw = f.filter((x) => Number(x.employeesAffected) < 0);
  const zerow = f.filter((x) => Number(x.employeesAffected) === 0);
  console.log(`NY negative workers: ${negw.length}, zero workers: ${zerow.length}`);
}
// CA
{
  const bytes = new Uint8Array(readFileSync(join(dir, "ca-warn.xlsx")));
  const rows = caWarn.parse({ kind: "bytes", bytes, status: 200, url: "f", fetchedAt: "" } as any);
  const f = rows.map((r) => caWarn.normalise(r));
  const neg = f.filter((x) => x.processedDate && daysBetween(String(x.noticeDate), String(x.processedDate)) < 0);
  console.log(`CA: ${f.length} rows; processed-before-notice: ${neg.length}`);
  for (const x of neg.slice(0, 8)) console.log("   neg:", x.company, x.noticeDate, "->", x.processedDate, daysBetween(String(x.noticeDate), String(x.processedDate)));
  const zerow = f.filter((x) => Number(x.employeesAffected) === 0);
  console.log(`CA zero workers: ${zerow.length}`);
}
