import { daysBetween } from "./canon";

/**
 * Deterministic, jurisdiction-parameterised. The verdict word is "gap", never
 * "violation" — employers can claim exceptions, and this is the dated proof a
 * person brings to a lawyer, not the lawyer.
 */
export const WARN_STATUTORY_DAYS: Record<string, number> = {
  "US": 60,
  "US-NY": 90,
  "US-CA": 60,
  // Maryland's Economic Stabilization Act matches the federal 60 days, but
  // bites at a lower threshold — small layoffs appear here that never reach a
  // federal-threshold file.
  "US-MD": 60,
  // Colorado has no state WARN act; the federal 60 days is the whole rule.
  "US-CO": 60,
  // North Carolina has no state WARN act either.
  "US-NC": 60,
  // Virginia has no state WARN act either; federal 60 days is the whole rule.
  "US-VA": 60,
};

export const WARN_EXCEPTIONS: Record<string, string[]> = {
  "US": ["faltering company", "unforeseeable business circumstances", "natural disaster"],
  "US-NY": ["faltering company", "unforeseeable business circumstances", "natural disaster", "strike or lockout"],
  "US-CA": ["physical calamity or act of war", "faltering company seeking capital (closures only)"],
  "US-MD": ["faltering company", "unforeseeable business circumstances", "natural disaster"],
  "US-CO": ["faltering company", "unforeseeable business circumstances", "natural disaster"],
  "US-NC": ["faltering company", "unforeseeable business circumstances", "natural disaster"],
  "US-VA": ["faltering company", "unforeseeable business circumstances", "natural disaster"],
};

export interface NoticeGapInput {
  jurisdiction: string;
  noticeDate: string;
  effectiveDate: string;
  postedDate?: string;
}

export interface NoticeGapResult {
  ruleId: "warn.notice_gap";
  jurisdiction: string;
  statutoryDays: number;
  actualDays: number;
  /** Positive when notice was shorter than the statute. */
  gapDays: number;
  /** Days between the notice date and the state making it public. */
  postingLagDays: number | null;
  /** Posted after the layoff had already started. */
  postedAfterEffective: boolean | null;
  exceptionsThatMayApply: string[];
  verdict: "gap" | "within";
}

export function warnNoticeGap(input: NoticeGapInput): NoticeGapResult {
  const statutoryDays = WARN_STATUTORY_DAYS[input.jurisdiction] ?? WARN_STATUTORY_DAYS["US"];
  const actualDays = daysBetween(input.noticeDate, input.effectiveDate);
  const gapDays = Math.max(0, statutoryDays - actualDays);
  const postingLagDays = input.postedDate ? daysBetween(input.noticeDate, input.postedDate) : null;
  const postedAfterEffective = input.postedDate ? daysBetween(input.effectiveDate, input.postedDate) > 0 : null;
  return {
    ruleId: "warn.notice_gap",
    jurisdiction: input.jurisdiction,
    statutoryDays,
    actualDays,
    gapDays,
    postingLagDays,
    postedAfterEffective,
    exceptionsThatMayApply: WARN_EXCEPTIONS[input.jurisdiction] ?? WARN_EXCEPTIONS["US"],
    verdict: gapDays > 0 ? "gap" : "within",
  };
}

export interface FalseCertInput {
  currentstatus: string;
  currentstatusdate: string;
  certifiedbydate?: string | null;
  class?: string | null;
}

export interface FalseCertResult {
  ruleId: "hpd.false_certification";
  /** Only the city's own words are ever surfaced as a verdict. */
  stamped: "FALSE CERTIFICATION" | "INVALID CERTIFICATION" | null;
  stampDate: string;
  certifyDate: string | null;
  hazardClass: string | null;
}

export function hpdFalseCertification(input: FalseCertInput): FalseCertResult {
  const s = input.currentstatus.trim().toUpperCase();
  const stamped = s === "FALSE CERTIFICATION" || s === "INVALID CERTIFICATION" ? s : null;
  return {
    ruleId: "hpd.false_certification",
    stamped,
    stampDate: input.currentstatusdate.slice(0, 10),
    certifyDate: input.certifiedbydate ? input.certifiedbydate.slice(0, 10) : null,
    hazardClass: input.class ?? null,
  };
}

/**
 * How much warning people got, in words. Some notices are dated after the
 * layoff has already begun; "-37 days' notice" is arithmetic, not English.
 */
export function noticePhrase(actualDays: number): string {
  if (actualDays < 0) {
    const n = -actualDays;
    return `dated ${n} day${n === 1 ? "" : "s"} after the layoff began`;
  }
  if (actualDays === 0) return "dated the day the layoff began";
  return `${actualDays} day${actualDays === 1 ? "" : "s"}' notice`;
}

/** Plain-English notice sentence, shared by every WARN adapter. */
export function noticeSentence(company: string, workers: number, site: string, r: NoticeGapResult, stateName: string): string {
  const days = noticePhrase(r.actualDays);
  const law = r.verdict === "gap"
    ? `${stateName} sets ${r.statutoryDays} days`
    : `inside the ${r.statutoryDays} days ${stateName} sets`;
  const lag = r.postingLagDays;
  const lagText = lag === null ? "" : lag === 0 ? "the same day" : `${lag} ${lag === 1 ? "day" : "days"} after the notice`;
  const posted =
    lag === null ? "" : r.postedAfterEffective ? ` Posted ${lagText}, once the layoff had started.` : ` Posted ${lagText}.`;
  const people = `${workers} ${workers === 1 ? "worker" : "workers"}`;
  return `${company} filed a layoff notice: ${people} at ${site}, ${days} (${law}).${posted}`;
}
