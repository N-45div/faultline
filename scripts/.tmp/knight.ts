import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vaWarn } from "../../engine/adapters/vaWarn";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { caWarn } from "../../engine/adapters/caWarn";
import { ncWarn } from "../../engine/adapters/ncWarn";
import { mdWarn } from "../../engine/adapters/mdWarn";
import { coWarn } from "../../engine/adapters/coWarn";
import { foldString } from "../../engine/canon";
import { layoffReceipt, receiptText, type LayoffNoticeRow } from "../../engine/receipt";
const dir = join("data", "snapshots", "2026-08-29T140311Z");
const t = (f: string) => ({ kind: "text" as const, text: readFileSync(join(dir, f), "utf8"), status: 200, url: "f", fetchedAt: "" });
const J: any = { "ny-warn": "US-NY", "va-warn": "US-VA", "ca-warn": "US-CA", "nc-warn": "US-NC", "md-warn": "US-MD", "co-warn": "US-CO" };
const cases: [any, any][] = [[nyWarn, t("ny-warn.csv")], [vaWarn, t("va-warn.csv")], [ncWarn, t("nc-warn.csv")], [coWarn, t("co-warn.csv")], [mdWarn, t("md-warn.html")], [caWarn, { kind: "bytes", bytes: new Uint8Array(readFileSync(join(dir, "ca-warn.xlsx"))), status: 200, url: "f", fetchedAt: "" }]];
const rows: (LayoffNoticeRow & { key: string; src: string })[] = [];
for (const [a, body] of cases) for (const r of a.parse(body)) {
  const f = a.normalise(r); const s = a.subjectOf(r);
  rows.push({ company: String(f.company), siteAddress: String(f.siteAddress), workers: Number(f.employeesAffected) || 0,
    noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate), postedDate: String(f.postedDate ?? f.processedDate ?? ""),
    jurisdiction: J[a.id], key: s.key, src: a.id } as any);
}
for (const name of ["Knight Facilities Management, Inc.", "Crothall Healthcare"]) {
  const mine = rows.filter((r) => foldString(r.company) === foldString(name));
  const keys = [...new Set(mine.map((r) => r.key))];
  const srcs = [...new Set(mine.map((r) => r.src))];
  console.log(`\n${name}: ${mine.length} filings, ${keys.length} site keys, sources ${srcs.join(",")}`);
  // what the receipt would do: findEmployerSites caps at 25 keys, versionsFor at 12
  const capped = keys.slice(0, 25);
  const shown = mine.filter((r) => capped.includes(r.key));
  const rec = layoffReceipt(name, capped[0], shown, { versionsSince: "2026-08-29", held: { rows: Math.min(keys.length, 12), versions: Math.min(keys.length, 12), reads: 97, since: Date.UTC(2026,7,29) } });
  console.log("  headline: " + rec.headline);
  console.log("  held    : " + rec.footer.at(-1));
}
