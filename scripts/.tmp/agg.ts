import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vaWarn } from "../../engine/adapters/vaWarn";
import { coWarn } from "../../engine/adapters/coWarn";
import { nyWarn } from "../../engine/adapters/nyWarn";
import { aggregationLine, type LayoffNoticeRow } from "../../engine/receipt";
import { foldString } from "../../engine/canon";

const dir = join("data", "snapshots", "2026-08-29T140311Z");
function load(a: any, file: string, j: LayoffNoticeRow["jurisdiction"]): LayoffNoticeRow[] {
  const rows = a.parse({ kind: "text", text: readFileSync(join(dir, file), "utf8"), status: 200, url: "f", fetchedAt: "" });
  return rows.map((r: any) => {
    const f = a.normalise(r);
    return {
      company: String(f.company), siteAddress: String(f.siteAddress), workers: Number(f.employeesAffected) || 0,
      noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate), postedDate: String(f.postedDate ?? ""),
      jurisdiction: j, layoffOrClosure: f.layoffOrClosure ? String(f.layoffOrClosure) : undefined,
      reason: f.reason ? String(f.reason) : undefined,
    } as LayoffNoticeRow;
  });
}

for (const [a, file, j] of [[vaWarn, "va-warn.csv", "US-VA"], [coWarn, "co-warn.csv", "US-CO"], [nyWarn, "ny-warn.csv", "US-NY"]] as any[]) {
  const all = load(a, file, j);
  // group by employer, as the receipt does
  const byCompany = new Map<string, LayoffNoticeRow[]>();
  for (const r of all) byCompany.set(foldString(r.company), [...(byCompany.get(foldString(r.company)) ?? []), r]);
  let fired = 0;
  const samples: string[] = [];
  const ties: string[] = [];
  for (const [c, rows] of byCompany) {
    const lines = rows.map((r) => aggregationLine(r, rows));
    lines.forEach((l, i) => {
      if (!l) return;
      fired++;
      if (samples.length < 8) samples.push(`${rows[i].company} | site="${rows[i].siteAddress}" | ${rows[i].noticeDate} | ${l}`);
    });
    // ordinal ties: two rows with the same ordinal claim
    const ords = lines.map((l) => (l ? /^(\d+)(st|nd|rd|th) notice/.exec(l)?.[1] : null));
    const counts = new Map<string, number>();
    ords.forEach((o, i) => { if (o) counts.set(`${foldString(rows[i].siteAddress)}#${o}`, (counts.get(`${foldString(rows[i].siteAddress)}#${o}`) ?? 0) + 1); });
    for (const [k, n] of counts) if (n > 1 && ties.length < 5) ties.push(`${rows[0].company} ${k} claimed by ${n} rows`);
  }
  console.log(`\n=== ${a.id}: ${fired} rows get an aggregation line (of ${all.length})`);
  for (const s of samples) console.log("   " + s);
  console.log(`   ordinal ties: ${ties.length}`);
  for (const t of ties) console.log("     " + t);
  // how many aggregations involve a non-address location
  const vague = all.filter((r) => /statewide|^remote|various|multiple/i.test(r.siteAddress));
  console.log(`   rows whose "site" is not an address at all: ${vague.length}`);
}
