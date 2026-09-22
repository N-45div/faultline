import { challengeDeadline, withoutUnit, type Answer } from "./hpd";

// The letter Faultline's agent writes, from its own inbox, to someone a tenant
// names as helping them: an organizer, a lawyer, a relative. It is built from
// the city's fields and the answer's one word, and from nothing the tenant
// typed: an address box on a public page must never become a way to put
// someone's words in front of a stranger. The note an answer carried is not
// even an input here.

export interface ShareInput {
  violationId: string;
  /** The building's parcel number: its public page and the city's rows are linked by it. */
  bbl: string;
  hazardClass: string;
  /** The city's words, as they stood when the tenant was asked. */
  description: string;
  askedStatus: string;
  askedStatusDate: string;
  certifiedBy: string | null;
  answer: Answer;
  /** When the answer was kept, epoch ms. */
  saidAt: number;
  site: string;
  inbox: string;
}

const WORD: Record<Answer, string> = { fixed: "FIXED", still_broken: "STILL BROKEN", not_sure: "NOT SURE" };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The city's own row for one violation, as its open-data API serves it. */
export function cityRowUrl(violationId: string): string {
  const where = encodeURIComponent(`violationid='${violationId}'`).replace(/'/g, "%27");
  return `https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$where=${where}`;
}

export function shareLetter(s: ShareInput): { subject: string; text: string } {
  const deadline = challengeDeadline({
    violationId: s.violationId,
    status: s.askedStatus,
    statusDate: s.askedStatusDate,
    certifiedBy: s.certifiedBy,
    hazardClass: s.hazardClass,
    description: s.description,
  });
  const words = withoutUnit(s.description.replace(/\s+/g, " ").trim()).slice(0, 400);
  const lines = [
    `Someone who used Faultline's public page asked us to send you this. Faultline doesn't know who they are, and this letter holds nothing they typed.`,
    ``,
    `The city's record: violation #${s.violationId}, class ${s.hazardClass || "not given"}, in the building at ${s.site}/b/${s.bbl}.`,
    `"${words}"`,
    `${s.askedStatus} as of ${s.askedStatusDate}${s.certifiedBy ? `; the owner certified it on ${s.certifiedBy}` : ""}.`,
    deadline ? `HPD's 70 days run to ${deadline}. After that the city can close it on the owner's word unless an inspector goes back.` : ``,
    ``,
    // Every letter comes from the browser trial, which does not know who is answering: the letter says so, so a
    // forwarded copy never reads as a tenant's checked word.
    `Their answer, given in Faultline's browser trial: ${WORD[s.answer]}, kept on ${day(s.saidAt)} at ${s.site}/try. The trial does not check who is answering, and its answers are never counted on the building's public page.`,
    ``,
    `The city's own row: ${cityRowUrl(s.violationId)}`,
    `How a tenant challenges a certification: call 311 or use nyc.gov/311, give the violation number, and say the condition is still there.`,
    ``,
    `Reply to this email and your reply is kept, dated, beside this record, where they can see it. Reply STOP and this address gets nothing more from us.`,
    ``,
    `Faultline · ${s.inbox}`,
  ].filter((l, i, all) => !(l === "" && all[i - 1] === ""));
  return { subject: `Repair #${s.violationId}: the city's record, and an answer from Faultline's browser trial`, text: lines.join("\n") };
}

/** An address as the page may show it back: the first letter and the domain. */
export function masked(address: string): string {
  const [local, domain] = address.split("@");
  return `${(local ?? "").slice(0, 1)}•••@${domain ?? ""}`;
}

/** An address the agent may write to: one mailbox, well formed, not an agent inbox (no loops). */
export function shareable(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (a.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(a)) return false;
  return !a.endsWith("@agentmail.to");
}
