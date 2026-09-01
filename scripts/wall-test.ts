import { groupForWall, type WallChange } from "../engine/wall";

// The wall's grouping and ranking, on hand-made changes.
//   npx tsx scripts/wall-test.ts

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

const building = (status: string, cls: string, kind: WallChange["kind"] = "added", key = "3012345678"): WallChange => ({
  kind,
  subjectKey: key,
  after: { __subjectKind: "building", __subjectLabel: "153-50 75 AVENUE, Queens", currentstatus: status, currentstatusdate: "2026-08-31", class: cls },
  sentence: `A violation at 153-50 75 AVENUE, Queens (class ${cls}) is ${status} as of 2026-08-31.`,
});

const layoff: WallChange = {
  kind: "added",
  subjectKey: "acme|richmond-va",
  after: { __subjectKind: "employer_site", company: "Acme" },
  sentence: "Acme filed a layoff notice: 40 workers at Richmond VA, 12 days' notice (Virginia sets 60).",
};

const rows = groupForWall([
  building("VIOLATION WILL BE REINSPECTED", "B"),
  building("VIOLATION WILL BE REINSPECTED", "B"),
  building("VIOLATION WILL BE REINSPECTED", "C"),
  building("VIOLATION WILL BE REINSPECTED", "A"),
  layoff,
  building("FALSE CERTIFICATION", "C", "changed", "2099999999"),
  building("VIOLATION OPEN", "B", "added", "2088888888"),
]);

for (const r of rows) console.log(`    [w${r.weight} x${r.count}] ${r.sentence}`);

check(rows.length === 4, `seven changes became ${rows.length} lines`);
const grouped = rows.find((r) => r.count === 4);
check(Boolean(grouped), "four routine rows at one building became one line");
check(/4 violations at 153-50 75 AVENUE, Queens are VIOLATION WILL BE REINSPECTED/.test(grouped?.sentence ?? ""), "the grouped line counts them");
check(/1 class C, 2 class B, 1 class A/.test(grouped?.sentence ?? ""), "the class mix reads C, B, A");
check(grouped?.weight === 1, "routine churn is weight 1");
check(rows[0].weight === 3 && rows[1].weight === 3, "the filing and the stamp lead");
check(rows.some((r) => /HPD stamped 1 violation .* FALSE CERTIFICATION/.test(r.sentence) === false && /FALSE CERTIFICATION/.test(r.sentence)), "a single stamp keeps its own sentence");
check(rows.at(-1)?.weight === 1, "routine rows come last");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
