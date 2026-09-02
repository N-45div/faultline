import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vaWarn } from "../../engine/adapters/vaWarn";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { caWarn } from "../../engine/adapters/caWarn";
import { ncWarn } from "../../engine/adapters/ncWarn";
import { mdWarn } from "../../engine/adapters/mdWarn";
import { coWarn } from "../../engine/adapters/coWarn";
import { foldString } from "../../engine/canon";
const dir = join("data", "snapshots", "2026-08-29T140311Z");
const t = (f: string) => ({ kind: "text" as const, text: readFileSync(join(dir, f), "utf8"), status: 200, url: "f", fetchedAt: "" });
const cases: [any, any][] = [[nyWarn, t("ny-warn.csv")], [vaWarn, t("va-warn.csv")], [ncWarn, t("nc-warn.csv")], [coWarn, t("co-warn.csv")], [mdWarn, t("md-warn.html")], [caWarn, { kind: "bytes", bytes: new Uint8Array(readFileSync(join(dir, "ca-warn.xlsx"))), status: 200, url: "f", fetchedAt: "" }]];
const byCompany = new Map<string, { keys: Set<string>; rows: number; name: string }>();
for (const [a, body] of cases) {
  for (const r of a.parse(body)) {
    const s = a.subjectOf(r);
    const c = foldString(s.label.split(" — ")[0]);
    const e = byCompany.get(c) ?? { keys: new Set<string>(), rows: 0, name: s.label.split(" — ")[0] };
    e.keys.add(s.key); e.rows++;
    byCompany.set(c, e);
  }
}
const top = [...byCompany.values()].sort((a, b) => b.keys.size - a.keys.size).slice(0, 12);
for (const e of top) console.log(`${e.keys.size} sites, ${e.rows} filings — ${e.name}`);
