// The tenant loop, by phone.
//
// Someone who asked about a building can have the questions put to them on a
// call instead: their phone rings, each certified repair is read to them, and
// they say whether it is fixed. CALL-E places the call and speaks; this file
// is everything about it that can be decided without a network - which numbers
// may be rung, the script the voice is given, the shape its answers must come
// back in, and what we accept from them.
//
// On a call a model does speak, so it is given the tool's words to say and
// told to state nothing else. What is *recorded* is not its to decide: each
// answer comes back as a violation number and one of three words, and goes
// through the same reader as a typed "#19041834 STILL BROKEN" - which refuses
// a number this person was never asked about.

import { sayCondition, sayDate } from "./speech";

export type CallQuestion = { violationId: string; description: string; statusDate: string };
export type CallAnswer = { violationId: string; answer: "fixed" | "still_broken" | "not_sure"; words: string };
/** One line of the call as it was transcribed: "you" is the person who answered, anything else is the voice. */
export type CallTurn = { who: string; text: string };

/** Where CALL-E may ring for us: a US or an Indian mobile or landline, typed by the person who wants the call. */
export function normalisePhone(raw: string): { e164: string; region: "US" | "IN"; locale: string } | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  let e164 = "";
  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else if (digits.length === 12 && digits.startsWith("91")) e164 = `+${digits}`;
  if (/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) return { e164, region: "US", locale: "en-US" };
  if (/^\+91[6-9]\d{9}$/.test(e164)) return { e164, region: "IN", locale: "en-IN" };
  return null;
}

/**
 * Did they write this number themselves? The last ten digits of the number to
 * be rung must appear, in order, among the digits of their own message.
 */
export function wroteNumber(theirMessage: string, phone: string): boolean {
  const to = normalisePhone(phone);
  if (!to) return false;
  return theirMessage.replace(/\D/g, "").includes(to.e164.replace(/\D/g, "").slice(-10));
}

/** What the voice is given. Every fact in it is one the tools already wrote; it is told to add none. */
export function callTask(questions: CallQuestion[], inbox: string): string {
  const repairs = questions
    .map(
      (q, i) =>
        `Repair ${i + 1} (violation ${q.violationId}): say "The city's record says the owner certified, on ${sayDate(q.statusDate)}, that this was corrected: ${sayCondition(q.description)}." Then ask: "Is it fixed, still broken, or are you not sure?"`,
    )
    .join("\n");
  return [
    "You are placing one short automated phone call for Faultline, a free service that keeps a New York City tenant's own word beside the city's housing record. The person you are calling asked for this call a moment ago on Faultline's website, by typing this phone number themselves.",
    "",
    'Say this first, exactly: "Hello. This is an automated call from Faultline. You asked for it on our website a moment ago, and it takes about a minute. If you did not ask for this call, say so now and we will not call this number again."',
    "If they say they did not ask for it, or ask not to be called, apologise in one sentence, tell them this number will not be called again, and end the call.",
    "",
    `Then ask about each of the ${questions.length === 1 ? "repair" : `${questions.length} repairs`} below, one at a time, in this order. Let them answer in their own words. If an answer is unclear, ask once more, then move on.`,
    repairs,
    "",
    'When you have asked about every repair, say exactly: "Thank you. Your answers are kept, dated, beside the city\'s record, and they are on the page you called from. Goodbye." Then end the call.',
    "",
    "Rules. Speak plainly and unhurriedly. Never state a fact that is not written above. Do not give advice, do not talk about the law, the owner or the building beyond the sentences above, and do not promise anything. Never ask for a name, an apartment number or any personal detail. If they ask who is calling, say again that this is an automated call from Faultline that they requested. If they ask for anything else, say you can only ask about these repairs, and that they can write to " +
      inbox.replace("@", " at ").replace(/\./g, " dot ") +
      ".",
  ].join("\n");
}

/** The only shape an answer may come back in: a number we asked about, and one of three words. */
export function callResultSchema(violationIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reached", "asked_for_this_call", "answers"],
    properties: {
      reached: { type: "string", enum: ["yes", "no", "unknown"], description: "yes if a person answered and spoke. no for voicemail, no answer, busy, or a failed call." },
      asked_for_this_call: {
        type: "string",
        enum: ["yes", "no", "unknown"],
        description: "no ONLY if the person said they did not request this call, or asked not to be called again. Otherwise yes, or unknown if nobody spoke.",
      },
      answers: {
        type: "array",
        description: "One entry for each repair the person said something about.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["violation", "answer", "their_words"],
          properties: {
            violation: { type: "string", enum: violationIds, description: "The violation number of the repair this answer is about." },
            answer: {
              type: "string",
              enum: ["fixed", "still_broken", "not_sure", "no_answer"],
              description:
                "fixed: they said the repair was made or it works now. still_broken: the condition is still there, came back, was only covered up, or the work was not done. not_sure: they have not checked or do not know. no_answer: they did not answer about this repair.",
            },
            their_words: { type: "string", description: "A short direct quote of what the person said about this repair, in their own words, at most 160 characters. Empty if they said nothing about it." },
          },
        },
      },
    },
  };
}

/** What we take from a finished call: only repairs we asked about, only the three words, one answer each. */
export function answersFromCall(structured: unknown, asked: string[]): { answers: CallAnswer[]; declined: boolean; reached: boolean } {
  const s = (structured ?? {}) as { reached?: unknown; asked_for_this_call?: unknown; answers?: unknown };
  const seen = new Set<string>();
  const answers: CallAnswer[] = [];
  for (const a of Array.isArray(s.answers) ? s.answers : []) {
    const violationId = String((a as any)?.violation ?? "").replace(/\D/g, "");
    const answer = String((a as any)?.answer ?? "");
    if (!asked.includes(violationId) || seen.has(violationId)) continue;
    if (answer !== "fixed" && answer !== "still_broken" && answer !== "not_sure") continue;
    seen.add(violationId);
    const words = String((a as any)?.their_words ?? "")
      .replace(/\s+/g, " ")
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      // Their words must not be able to change what is recorded: the number and
      // the three answer words belong to the line we write, not to the quote.
      .replace(/#\s?\d{5,10}/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;])/g, "$1")
      .trim()
      .slice(0, 160);
    answers.push({ violationId, answer, words });
  }
  return { answers, declined: s.asked_for_this_call === "no", reached: s.reached === "yes" || answers.length > 0 };
}

const wordsOf = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/**
 * Did they say it? A quote is kept only if most of its words are words the
 * person spoke on the call. Transcription bends a contraction; it does not
 * invent a sentence, and neither may a model that is summarising one.
 */
export function saidIt(quote: string, turns: CallTurn[]): boolean {
  const said = new Set(wordsOf(turns.filter((t) => t.who === "you").map((t) => t.text).join(" ")));
  const words = wordsOf(quote);
  if (words.length === 0 || said.size === 0) return false;
  return words.filter((w) => said.has(w)).length / words.length >= 0.8;
}

/** What the second reader is handed: the repairs by number, in the city's words, and the call as it was transcribed. */
export function secondReaderInput(questions: CallQuestion[], turns: CallTurn[]): string {
  return [
    "The repairs the call asked about:",
    ...questions.map((q) => `- violation ${q.violationId}: ${q.description.replace(/\s+/g, " ").trim().slice(0, 300)}`),
    "",
    "The call, as it was transcribed. CALL is the automated voice. THEM is the person who answered the phone.",
    ...turns.map((t) => `${t.who === "you" ? "THEM" : "CALL"}: ${t.text.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
}

/**
 * Two readers, one call. CALL-E, which held the conversation, says what it
 * heard; GPT-6 Astra reads the transcript without being told what CALL-E made
 * of it. An answer stands only where both read the same word for the same
 * repair. Where they differ, or only one of them heard an answer, nothing is
 * recorded and the person is asked again in writing. If either reader heard
 * them say they never asked for the call, nothing at all is recorded.
 *
 * With no second reader (no key, a cap reached, the model down) the first
 * stands alone, as a typed keyword does. Either way a quote is kept only if
 * the transcript has them saying it.
 */
export function settle(
  first: CallAnswer[],
  second: { answers: CallAnswer[]; declined: boolean } | null,
  turns: CallTurn[],
): { agreed: CallAnswer[]; unsure: string[]; declined: boolean } {
  const quote = (...candidates: string[]): string => candidates.find((w) => w.length > 0 && saidIt(w, turns)) ?? "";
  if (!second) return { agreed: first.map((a) => ({ ...a, words: quote(a.words) })), unsure: [], declined: false };
  if (second.declined) return { agreed: [], unsure: [], declined: true };
  const agreed: CallAnswer[] = [];
  const unsure: string[] = [];
  for (const id of [...new Set([...first, ...second.answers].map((a) => a.violationId))]) {
    const a = first.find((x) => x.violationId === id);
    const b = second.answers.find((x) => x.violationId === id);
    if (a && b && a.answer === b.answer) agreed.push({ violationId: id, answer: a.answer, words: quote(b.words, a.words) });
    else unsure.push(id);
  }
  return { agreed, unsure, declined: false };
}

/** An answer from a call, as the line a person would have typed: read by the keyword reader, with no model. */
export function answerLine(a: CallAnswer): string {
  const word = a.answer === "fixed" ? "FIXED" : a.answer === "still_broken" ? "STILL BROKEN" : "NOT SURE";
  return `#${a.violationId} ${word}`;
}
