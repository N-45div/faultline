// Just enough HTML to read a government table. No DOM, no dependency: these
// pages are one plain table that has kept the same shape for sixteen years,
// and a parser that assumes anything more would break on the year they hand-
// paste a row.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "...",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
}

/** A cell's text: tags gone, breaks become spaces, whitespace collapsed. */
export function cellText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|tr|td|th)>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every row of every table on the page, as arrays of cell text. Callers pick
 * the table they want by its header row rather than by position, because a
 * second table can appear on these pages without warning.
 */
export function tables(html: string): string[][][] {
  const out: string[][][] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let t: RegExpExecArray | null;
  while ((t = tableRe.exec(html)) !== null) {
    const rows: string[][] = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(t[1])) !== null) {
      const cells: string[] = [];
      const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let c: RegExpExecArray | null;
      while ((c = cellRe.exec(r[1])) !== null) cells.push(cellText(c[2]));
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) out.push(rows);
  }
  return out;
}

/**
 * The table whose header row carries these column names, as objects keyed by
 * the header. Chosen by content, never by position — if the page grows another
 * table, this still finds the right one, and if the columns are renamed we get
 * nothing rather than silently reading the wrong column.
 */
export function tableByHeaders(html: string, required: string[]): Record<string, string>[] {
  const want = required.map((h) => h.toLowerCase());
  for (const rows of tables(html)) {
    const headerIndex = rows.findIndex((row) => {
      const lower = row.map((c) => c.toLowerCase());
      return want.every((w) => lower.includes(w));
    });
    if (headerIndex === -1) continue;
    const headers = rows[headerIndex];
    return rows
      .slice(headerIndex + 1)
      .filter((cells) => cells.length === headers.length && cells.some((c) => c !== ""))
      .map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
  }
  return [];
}
