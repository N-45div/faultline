import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { foldString } from "../../engine/canon";
import { layoffReceipt, receiptText, receiptHtml, type LayoffNoticeRow } from "../../engine/receipt";
const dir = join("data", "snapshots", "2026-08-29T140311Z");
const raw = nyWarn.parse({ kind: "text", text: readFileSync(join(dir, "ny-warn.csv"), "utf8"), status: 200, url: "f", fetchedAt: "" });
const all: LayoffNoticeRow[] = raw.map((r: any) => { const f = nyWarn.normalise(r);
  return { company: String(f.company), siteAddress: String(f.siteAddress), workers: Number(f.employeesAffected) || 0,
    noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate), postedDate: String(f.postedDate), jurisdiction: "US-NY" } as LayoffNoticeRow; });
const k = all.filter((r) => foldString(r.company) === foldString("Knight Facilities Management, Inc."));
console.log(`true: ${k.length} filings, ${k.reduce((n,r)=>n+r.workers,0)} workers`);
const capped = k.slice(0, 25);
console.log(`shown: ${capped.length} filings, ${capped.reduce((n,r)=>n+r.workers,0)} workers`);
console.log(layoffReceipt("Knight Facilities Management", "x", capped, { versionsSince: "2026-08-29" }).headline);

// receiptHtml vs receiptText on a STOP confirmation and a nothing-filed receipt
import { noMatchReceipt } from "../../engine/receipt";
const stop = { kind: "none" as const, query: "stop", headline: "Stopped. We won't email you again unless you ask.", blocks: [], links: [], footer: [] };
console.log("\n--- STOP text ---\n" + receiptText(stop));
console.log("\n--- STOP html ---\n" + receiptHtml(stop));
const none = noMatchReceipt("Initech", [], { at: Date.UTC(2026,8,3,1,0), followKey: "q:initech", provenance: [{ publisher: "New York", url: "u", at: 1, status: 200, rows: 193, lastChecked: Date.UTC(2026,8,2,18,30) }] });
console.log("\n--- none html FOLLOW lines ---");
for (const m of receiptHtml(none).match(/Reply FOLLOW[^<]*/g) ?? []) console.log("  " + m);
console.log("--- none text FOLLOW lines ---");
for (const m of receiptText(none).match(/Reply FOLLOW.*/g) ?? []) console.log("  " + m);
