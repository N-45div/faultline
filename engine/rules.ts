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
};

export const WARN_EXCEPTIONS: Record<string, string[]> = {
  "US": ["faltering company", "unforeseeable business circumstances", "natural disaster"],
  "US-NY": ["faltering company", "unforeseeable business circumstances", "natural disaster", "strike or lockout"],
  "US-CA": ["physical calamity or act of war", "faltering company seeking capital (closures only)"],
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

/** Plain-English notice sentence, shared by the NY and CA adapters. */
export function noticeSentence(company: string, workers: number, site: string, r: NoticeGapResult, stateName: string): string {
  const days = `${r.actualDays} day${r.actualDays === 1 ? "" : "s"}' notice`;
  const law = r.verdict === "gap"
    ? `${stateName} sets ${r.statutoryDays}`
    : `inside the ${r.statutoryDays} ${stateName} sets`;
  const posted = r.postedAfterEffective
    ? ` Posted ${r.postingLagDays} days after the notice, once the layoff had started.`
    : r.postingLagDays !== null ? ` Posted ${r.postingLagDays} days after the notice.` : "";
  return `${company} filed a layoff notice: ${workers} workers at ${site}, ${days} (${law}).${posted}`;
}
