import { parseAnswer, type Answer } from "./hpd";
import { looksLikeAddress } from "./match";

// What did the person mean by this email? Deterministic; the model comes in
// only for letters, and only after this has had its say.

export type Intent =
  | { kind: "lookup"; query: string }
  | { kind: "follow" }
  | { kind: "stop" }
  | { kind: "pack"; query: string }
  | { kind: "csv"; query: string }
  | { kind: "keep"; url: string }
  | { kind: "find"; what: string }
  | { kind: "call"; phone: string | null }
  | { kind: "monitor" }
  | { kind: "letter"; text: string }
  | { kind: "answer"; answer: Answer; violationId: string | null; note: string }
  | { kind: "ask"; query: string }
  | { kind: "empty" };

const LETTER_WORDS = /\b(position|eliminat|terminat|severance|layoff|laid off|release|separation|last day|WARN|notice period|landlord|repair|violation|inspection)\b/i;

export function classifyInbound(subjectRaw: string, bodyRaw: string, opts: { answers?: boolean } = {}): Intent {
  const subject = cleanSubject(subjectRaw);
  const body = bodyRaw.replace(/\r/g, "").trim();
  const firstLine = (body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "").slice(0, 200);

  // A one-word command can arrive as the subject or as the first line of a
  // reply whose subject is ours. Check both.
  const commands = [firstLine, subject].map((s) => s.toLowerCase().replace(/[^a-z]+$/, ""));
  if (commands.some((c) => /^(follow|watch|subscribe|yes)$/.test(c))) return { kind: "follow" };
  if (commands.some((c) => /^(stop|unsubscribe|unfollow)$/.test(c))) return { kind: "stop" };

  // "ASK <address>", or a bare ASK in a building's thread: the repairs an
  // owner has certified there, asked about now rather than when the next one
  // is certified. Before the answer test, because "ask … is it fixed" holds an
  // answer word. Our own subject comes back on replies, so inside a reply only
  // the body may ask.
  const replying = /^\s*(re|fwd|fw)\s*:/i.test(subjectRaw ?? "");
  const askMatch = (replying ? null : /^ask\b[:\s-]*(.*)$/i.exec(subject)) ?? /^ask\b[:\s-]*(.*)$/i.exec(firstLine);
  if (askMatch) return { kind: "ask", query: askMatch[1].trim().slice(0, 120) };

  // CALL ME and a number: ring me, and ask me by phone. The number has to be
  // in the message, because the only number we will ring is one they wrote.
  const callIn = [replying ? null : /^call\s*me\b[:\s-]*(.*)$/i.exec(subject), /^call\s*me\b[:\s-]*(.*)$/i.exec(firstLine)].filter((m): m is RegExpExecArray => m !== null);
  if (callIn.length > 0) {
    // "CALL ME" as the subject and the number in the body is one request, not two.
    const written = callIn.map((m) => m[1].trim().slice(0, 40)).find((w) => w.replace(/\D/g, "").length >= 10);
    return { kind: "call", phone: written ?? null };
  }

  // "Is it fixed?" answered: FIXED, STILL BROKEN or NOT SURE in the person's
  // own lines. Read before the letter test, because the quoted question below
  // those lines is long and talks about violations and repairs. The caller
  // turns this off when nobody asked this address anything.
  if (opts.answers !== false) {
    const answer = parseAnswer(subjectRaw, body);
    if (answer) return { kind: "answer", ...answer };
  }

  // Paid requests arrive as "PACK <company or address>" and "MONITOR". Our own
  // subject comes back on every message in the thread once we have replied, so
  // inside a reply only the body may ask — otherwise "thanks" reads as a
  // second request and we build and send the whole pack again.
  const isReply = /^\s*(re|fwd|fw)\s*:/i.test(subjectRaw ?? "");
  const packMatch = (isReply ? null : /^pack\b[:\s-]*(.*)$/i.exec(subject)) ?? /^pack\b[:\s-]*(.*)$/i.exec(firstLine);
  if (packMatch) return { kind: "pack", query: packMatch[1].trim().slice(0, 120) };
  // "CSV <employer>": every filing we hold for them, one row each, as a file.
  const csvMatch = (isReply ? null : /^(?:csv|export)\b[:\s-]*(.*)$/i.exec(subject)) ?? /^(?:csv|export)\b[:\s-]*(.*)$/i.exec(firstLine);
  if (csvMatch) return { kind: "csv", query: csvMatch[1].trim().slice(0, 120) };

  // "KEEP <link>", or a line that is nothing but a link: read that page now and
  // hold it as it was served. Only with a link in it, because "keep me posted"
  // is not a request to keep anything.
  const URL_IN = /https?:\/\/[^\s<>"]+/i;
  const keepMatch = (isReply ? null : /^keep\b[:\s-]*(.*)$/i.exec(subject)) ?? /^keep\b[:\s-]*(.*)$/i.exec(firstLine);
  const keepUrl = keepMatch ? URL_IN.exec(keepMatch[1]) : URL_IN.exec(firstLine) && /^https?:\/\/[^\s<>"]+$/i.test(firstLine) ? URL_IN.exec(firstLine) : null;
  if (keepUrl) return { kind: "keep", url: keepUrl[0].slice(0, 500) };

  // FIND and a name: what the open web has on them, with the first page held.
  // A link after FIND is a page, not a search, so KEEP above has it already.
  const findMatch = (isReply ? null : /^find\b[:\s-]*(.*)$/i.exec(subject)) ?? /^find\b[:\s-]*(.*)$/i.exec(firstLine);
  const findWhat = findMatch ? findMatch[1].trim().replace(/\s+/g, " ") : "";
  if (findWhat.length >= 3) {
    // Someone who writes FIND and a link has already found it; hold that page.
    const linkInFind = URL_IN.exec(findWhat);
    if (linkInFind) return { kind: "keep", url: linkInFind[0].slice(0, 500) };
    return { kind: "find", what: findWhat.slice(0, 200) };
  }
  if (commands.some((c) => /^monitor$/.test(c))) return { kind: "monitor" };

  // A letter: it talks like one. "I got a letter saying my position is being
  // eliminated. What can you tell me?" is short, and still not a company name.
  if (body.length > 80 && LETTER_WORDS.test(body)) return { kind: "letter", text: body };

  // A name or an address, in the subject or on the first line.
  const query = subject || firstLine;
  if (query && query.length <= 120) return { kind: "lookup", query };

  if (body.length > 0) return { kind: "letter", text: body };
  return { kind: "empty" };
}

export function cleanSubject(s: string): string {
  let out = (s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  // Strip reply/forward prefixes one at a time: untrusted input, no nested quantifiers.
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/^(re|fwd?|fw|aw|wg) ?: ?/i, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

export function isAddressQuery(q: string): boolean {
  return looksLikeAddress(q);
}

/** Good enough for forwarded mail: tags out, a few entities decoded, whitespace collapsed. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function emailAddressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from ?? "");
  return (m ? m[1] : from ?? "").trim().toLowerCase();
}
