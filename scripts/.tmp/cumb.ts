import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vaWarn } from "../../engine/adapters/vaWarn";
import { layoffReceipt, receiptText, type LayoffNoticeRow } from "../../engine/receipt";
import { foldString } from "../../engine/canon";
const dir = join("data", "snapshots", "2026-08-29T140311Z");
const raw = vaWarn.parse({ kind: "text", text: readFileSync(join(dir, "va-warn.csv"), "utf8"), status: 200, url: "f", fetchedAt: "" });
const all: LayoffNoticeRow[] = raw.map((r: any) => { const f = vaWarn.normalise(r);
  return { company: String(f.company), siteAddress: String(f.siteAddress), workers: Number(f.employeesAffected) || 0,
    noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate), postedDate: "", jurisdiction: "US-VA",
    layoffOrClosure: String(f.layoffOrClosure) } as LayoffNoticeRow; });
const rows = all.filter((r) => foldString(r.company) === foldString("Cumberland River Coal Company"));
console.log(receiptText(layoffReceipt("Cumberland River Coal", "x", rows, { versionsSince: "2026-08-29" })));
