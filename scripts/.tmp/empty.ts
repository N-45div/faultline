import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { vaWarn } from "../../engine/adapters/vaWarn";
import { ncWarn } from "../../engine/adapters/ncWarn";
import { coWarn } from "../../engine/adapters/coWarn";
import { mdWarn } from "../../engine/adapters/mdWarn";
import { caWarn } from "../../engine/adapters/caWarn";
import { warnNoticeGap, noticePhrase } from "../../engine/rules";

const dir = join("data", "snapshots", "2026-08-29T140311Z");
const text = (f: string) => ({ kind: "text" as const, text: readFileSync(join(dir, f), "utf8"), status: 200, url: "f", fetchedAt: "" });
const cases: [any, any, string][] = [
  [nyWarn, text("ny-warn.csv"), "US-NY"],
  [vaWarn, text("va-warn.csv"), "US-VA"],
  [ncWarn, text("nc-warn.csv"), "US-NC"],
  [coWarn, text("co-warn.csv"), "US-CO"],
  [mdWarn, text("md-warn.html"), "US-MD"],
  [caWarn, { kind: "bytes", bytes: new Uint8Array(readFileSync(join(dir, "ca-warn.xlsx"))), status: 200, url: "f", fetchedAt: "" }, "US-CA"],
];
for (const [a, body, j] of cases) {
  const rows = a.parse(body);
  const f = rows.map((r: any) => a.normalise(r));
  const noEff = f.filter((x: any) => !/^\d{4}-\d{2}-\d{2}$/.test(String(x.effectiveDate ?? "")));
  const noNot = f.filter((x: any) => !/^\d{4}-\d{2}-\d{2}$/.test(String(x.noticeDate ?? "")));
  console.log(`${a.id}: ${f.length} rows | bad effectiveDate: ${noEff.length} | bad noticeDate: ${noNot.length}`);
  for (const x of noEff.slice(0, 4)) {
    const g = warnNoticeGap({ jurisdiction: j, noticeDate: String(x.noticeDate), effectiveDate: String(x.effectiveDate) });
    console.log(`   ${JSON.stringify(x.company)} notice=${JSON.stringify(x.noticeDate)} eff=${JSON.stringify(x.effectiveDate)} -> actualDays=${g.actualDays} verdict=${g.verdict} phrase="${noticePhrase(g.actualDays)}"`);
  }
}
