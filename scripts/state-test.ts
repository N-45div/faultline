import { coWarn } from "../engine/adapters/coWarn";
import { mdWarn } from "../engine/adapters/mdWarn";
import { ncWarn } from "../engine/adapters/ncWarn";
import { vaWarn } from "../engine/adapters/vaWarn";
import type { SourceAdapter } from "../engine/types";
import { warnNoticeGap } from "../engine/rules";

// Reads each new state's real file and asserts on what actually comes back.
//   npx tsx scripts/state-test.ts

const UA = "Notice/0.1 (+https://github.com/N-45div/notice; keeps dated copies of public filings)";
const iso = /^\d{4}-\d{2}-\d{2}$/;
let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

async function check(adapter: SourceAdapter<any>, stateName: string, jurisdiction: string) {
  const t = adapter.transport;
  if (t.kind !== "http_text") throw new Error(`${adapter.id}: expected http_text`);

  // Same two-step the ingest action performs: some states rename the file on
  // every publish and link to it from one page that does not move.
  let url = t.url;
  if (t.discover) {
    const page = await fetch(t.discover.pageUrl, { headers: { "User-Agent": UA, Accept: "*/*" } });
    const found = t.discover.find(await page.text());
    ok("discovered today's file", Boolean(found), found ?? "nothing matched");
    if (found) url = found;
  }
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  const text = await res.text();
  console.log(`\n== ${adapter.id}  ${res.status}  ${text.length} bytes`);

  const rows = adapter.parse({ kind: "text", text, status: res.status, url: t.url, fetchedAt: new Date().toISOString() });
  ok("parsed rows", rows.length > 0, `${rows.length} rows`);
  if (rows.length === 0) return;

  const ids = rows.map((r) => adapter.identity(r));
  ok("identities unique", new Set(ids).size === ids.length, `${new Set(ids).size} of ${ids.length}`);
  ok("identities non-empty", ids.every((i) => i.length > 3));

  const fields = rows.map((r) => adapter.normalise(r));
  ok("notice dates ISO", fields.every((f) => iso.test(String(f.noticeDate))));
  ok("effective dates ISO or empty", fields.every((f) => f.effectiveDate === "" || iso.test(String(f.effectiveDate))));
  ok("worker counts numeric", fields.every((f) => typeof f.employeesAffected === "number" && !Number.isNaN(f.employeesAffected)));
  ok("subjects have labels", rows.every((r) => adapter.subjectOf(r).label.length > 2));
  ok("expected keys present", adapter.health.expectedKeys.every((k) => k in rows[0]));

  const usable = fields.filter((f) => iso.test(String(f.noticeDate)) && iso.test(String(f.effectiveDate)));
  const gaps = usable.map((f) => warnNoticeGap({ jurisdiction, noticeDate: String(f.noticeDate), effectiveDate: String(f.effectiveDate) }));
  const short = gaps.filter((g) => g.verdict === "gap").length;
  const negative = gaps.filter((g) => g.actualDays < 0).length;
  console.log(`  ${stateName}: ${short}/${gaps.length} under the ${gaps[0]?.statutoryDays ?? "?"}-day statute · ${negative} dated on or after the layoff`);
  const sentence = adapter.render(fields[0]);
  console.log(`  sentence: ${sentence}`);
  ok("sentence has no negative day count", !/-\d+ days?' notice/.test(sentence) && !fields.some((f) => /-\d+ days?' notice/.test(adapter.render(f))));
}

await check(mdWarn, "MD", "US-MD");
await check(coWarn, "CO", "US-CO");
await check(ncWarn, "NC", "US-NC");
await check(vaWarn, "VA", "US-VA");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
