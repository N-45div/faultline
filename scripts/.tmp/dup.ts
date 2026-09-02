import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { vaWarn } from "../../engine/adapters/vaWarn";
import { ncWarn } from "../../engine/adapters/ncWarn";
import { coWarn } from "../../engine/adapters/coWarn";
import { mdWarn } from "../../engine/adapters/mdWarn";
import { canonicalise, stableStringify } from "../../engine/canon";

const dir = join("data", "snapshots", "2026-08-29T140311Z");
const cases: [any, string][] = [
  [nyWarn, "ny-warn.csv"],
  [vaWarn, "va-warn.csv"],
  [ncWarn, "nc-warn.csv"],
  [coWarn, "co-warn.csv"],
  [mdWarn, "md-warn.html"],
];
for (const [a, file] of cases) {
  const text = readFileSync(join(dir, file), "utf8");
  const rows = a.parse({ kind: "text", text, status: 200, url: "fixture", fetchedAt: "" });
  const byId = new Map<string, any[]>();
  for (const r of rows) {
    const id = a.identity(r);
    byId.set(id, [...(byId.get(id) ?? []), r]);
  }
  const dups = [...byId.entries()].filter(([, v]) => v.length > 1);
  let differing = 0;
  const samples: string[] = [];
  for (const [id, list] of dups) {
    const sigs = new Set(list.map((r) => stableStringify(canonicalise(a.normalise(r), a.noise, a.significant))));
    if (sigs.size > 1) {
      differing++;
      if (samples.length < 3) samples.push(`${id}\n      ${[...sigs].join("\n      ")}`);
    }
  }
  console.log(`${a.id}: ${rows.length} rows, ${byId.size} identities, ${dups.length} duplicated identities, ${differing} of them with DIFFERENT significant fields`);
  for (const s of samples) console.log("    " + s);
}
