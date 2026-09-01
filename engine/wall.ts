import type { Fields } from "./types";

// What goes on the public wall, and how loudly. A city cycle can move nine
// violations at one building in one go; nine near-identical lines say less
// than one line that says nine. And a landlord's certification being stamped
// FALSE is news in a way that "will be reinspected" is not.

export interface WallChange {
  kind: "added" | "changed" | "removed";
  subjectKey: string;
  before?: Fields;
  after?: Fields;
  sentence: string;
}

export interface WallRow {
  sentence: string;
  subjectKey: string;
  /** How many changes this one line stands for. */
  count: number;
  /** 3: a filing, or the city's own stamp. 2: a status that moved. 1: routine. */
  weight: 1 | 2 | 3;
  /** Index into the input, for the change this row is anchored to. */
  first: number;
}

const STAMPS = new Set(["FALSE CERTIFICATION", "INVALID CERTIFICATION"]);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "class C, 2 class B" — the city's own scale, in the order that matters. */
function classMix(fields: Fields[]): string {
  const counts = new Map<string, number>();
  for (const f of fields) {
    const c = String(f.class ?? "").trim();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return ["C", "B", "A"]
    .filter((c) => counts.has(c))
    .map((c) => `${counts.get(c)} class ${c}`)
    .join(", ");
}

export function groupForWall(changes: WallChange[]): WallRow[] {
  const out: WallRow[] = [];
  const buildingGroups = new Map<string, number[]>();

  changes.forEach((c, i) => {
    const f = c.after ?? c.before;
    const isBuilding = f?.__subjectKind === "building";
    if (!isBuilding || !c.after) {
      // A layoff filing is always news; so is a row the state removed.
      out.push({ sentence: c.sentence, subjectKey: c.subjectKey, count: 1, weight: c.kind === "removed" ? 2 : 3, first: i });
      return;
    }
    const status = String(c.after.currentstatus ?? "");
    const key = `${c.subjectKey}|${c.kind}|${status}|${String(c.after.currentstatusdate ?? "")}`;
    buildingGroups.set(key, [...(buildingGroups.get(key) ?? []), i]);
  });

  for (const [, idx] of buildingGroups) {
    const first = changes[idx[0]];
    const after = first.after!;
    const status = String(after.currentstatus ?? "");
    const stamped = STAMPS.has(status);
    const weight: WallRow["weight"] = stamped ? 3 : first.kind === "changed" ? 2 : 1;
    if (idx.length === 1) {
      out.push({ sentence: first.sentence, subjectKey: first.subjectKey, count: 1, weight, first: idx[0] });
      continue;
    }
    const where = String(after.__subjectLabel ?? first.subjectKey);
    const on = String(after.currentstatusdate ?? "");
    const mix = classMix(idx.map((i) => changes[i].after!));
    const mixText = mix ? ` (${mix})` : "";
    const sentence = stamped
      ? `HPD stamped ${plural(idx.length, "violation", "violations")} at ${where} ${status} on ${on}${mixText}.`
      : first.kind === "changed"
        ? `${plural(idx.length, "violation", "violations")} at ${where} moved to ${status} on ${on}${mixText}.`
        : `${plural(idx.length, "violation", "violations")} at ${where} ${idx.length === 1 ? "is" : "are"} ${status} as of ${on}${mixText}.`;
    out.push({ sentence, subjectKey: first.subjectKey, count: idx.length, weight, first: idx[0] });
  }

  // Loudest first, then in the order they arrived.
  return out.sort((a, b) => b.weight - a.weight || a.first - b.first);
}
