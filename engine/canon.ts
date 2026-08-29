import type { Fields, NoiseRule, Scalar } from "./types";

/**
 * Canonical form exists only to be hashed. The stored record keeps the
 * source's original values; this copy is what two captures are compared on.
 */
export function canonicalise(fields: Fields, noise: NoiseRule[], only?: string[]): Fields {
  const out: Fields = {};
  for (const key of Object.keys(fields)) {
    if (only && !only.includes(key)) continue;
    let v: Scalar | undefined = fields[key];
    if (v === undefined) continue;
    for (const rule of noise) {
      if (rule.path !== key) continue;
      v = applyNoise(rule, v);
      if (v === undefined) break;
    }
    if (v === undefined) continue;
    out[key] = typeof v === "string" ? foldString(v) : v;
  }
  return out;
}

function applyNoise(rule: NoiseRule, v: Scalar): Scalar | undefined {
  switch (rule.op) {
    case "drop":
      return undefined;
    case "trimCase":
      return typeof v === "string" ? foldString(v) : v;
    case "round":
      return typeof v === "number" ? Number(v.toFixed(rule.decimals)) : v;
    case "dateOnly":
      return typeof v === "string" ? dateOnly(v) : v;
    case "replace":
      return typeof v === "string" ? v.replace(new RegExp(rule.pattern, rule.flags ?? "g"), rule.with) : v;
  }
}

export function foldString(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** "2026-08-25T00:00:00.000" → "2026-08-25". Never synthesises a time. */
export function dateOnly(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  return m ? m[1] : s.trim();
}

/** Deterministic JSON: sorted keys, no undefined. */
export function stableStringify(fields: Fields): string {
  const keys = Object.keys(fields).sort();
  return JSON.stringify(fields, keys);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashFields(fields: Fields, noise: NoiseRule[], only?: string[]): Promise<string> {
  return sha256Hex(stableStringify(canonicalise(fields, noise, only)));
}

/** Whole days from one date-only ISO string to another, sign preserved. */
export function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = dateOnly(fromIso).split("-").map(Number);
  const [ty, tm, td] = dateOnly(toIso).split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function slug(s: string): string {
  return foldString(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Fast non-cryptographic 64-bit hash (two FNV-1a passes), usable inside a mutation. */
export function fnv1a64(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= c;
    b = Math.imul(b, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
