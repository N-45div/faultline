/**
 * Firecrawl's change tracking, in git-diff mode, returns a unified diff of the
 * page's markdown against its previous capture. A commit page needs only what
 * moved: the hunk headers and the lines added or removed, capped so a page
 * that changed everywhere cannot fill a document.
 */
export function changedLines(diff: string, maxLines = 60, maxChars = 6_000): string {
  const lines = (diff ?? "").replace(/\r/g, "").split("\n");
  const hunks = lines.some((l) => l.startsWith("@@"));
  const kept: string[] = [];
  let inHunk = !hunks;
  let chars = 0;
  let more = 0;
  for (const line of lines) {
    // Everything before the first hunk is the diff's own header: file names, index lines.
    if (line.startsWith("@@")) inHunk = true;
    if (!inHunk) continue;
    if (!hunks && /^(---|\+\+\+)( |$)/.test(line)) continue;
    if (!(line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"))) continue;
    if (kept.length >= maxLines || chars + line.length + 1 > maxChars) {
      more++;
      continue;
    }
    kept.push(line);
    chars += line.length + 1;
  }
  if (more > 0) kept.push(`… ${more} more ${more === 1 ? "line" : "lines"}`);
  return kept.join("\n");
}
