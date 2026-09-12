/**
 * The ban list, run over everything a person can read: page copy, receipt
 * copy, email copy. The product is a receipt, and a receipt does not talk
 * about sources, adapters, snapshots or crawlers — those are our words, and
 * a reader who meets them stops trusting the rest.
 *   npx tsx scripts/copy-lint.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BAN = /\b(sources?|adapters?|snapshots?|diffs?|diffed|monitor(?:ing)?|crawl(?:er|ed|ing)?|webhooks?|watch(?:ed|ing)?|scrap(?:e|ed|ing)|ingest(?:ed|ion)?|cron|backend|database|deployment)\b/i;
// Words that are a name, not a leak: the "Monitor" plan is called that.
const ALLOW = [/^"MONITOR"$/, /^"Monitor: /, /^>Monitor<$/, /^"monitor"$/, /\bMonitor plan\b/i];

// Files.tsx is the one page that speaks git on purpose — log, commit, diff —
// because that is the plainest proof the old version existed. It is the
// developer-facing surface, not a receipt, and its words are the point.
const files = [
  ...readdirSync("src").filter((f) => f.endsWith(".tsx") && f !== "Files.tsx").map((f) => join("src", f)),
  "engine/receipt.ts",
  "engine/rules.ts",
  "convex/digest.ts",
  "convex/inbound.ts",
  "convex/packBuild.ts",
];

let hits = 0;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("import ")) return;
    // Only what reaches a reader: string literals and JSX text.
    const readable = l.match(/"[^"\n]*"|`[^`\n]*`|'[^'\n]*'|>[^<{}\n]*</g) ?? [];
    for (const q of readable) {
      if (!BAN.test(q)) continue;
      if (ALLOW.some((a) => a.test(q))) continue;
      console.log(`${f}:${i + 1}: ${q.trim().slice(0, 120)}`);
      hits++;
    }
  });
}
console.log(hits === 0 ? "copy lint: clean" : `copy lint: ${hits} hit${hits === 1 ? "" : "s"}`);
process.exit(hits === 0 ? 0 : 1);
