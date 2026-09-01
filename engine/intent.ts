import { looksLikeAddress } from "./match";

// What did the person mean by this email? Deterministic; the model comes in
// only for letters, and only after this has had its say.

export type Intent =
  | { kind: "lookup"; query: string }
  | { kind: "follow" }
  | { kind: "stop" }
  | { kind: "pack"; query: string }
  | { kind: "monitor" }
  | { kind: "letter"; text: string }
  | { kind: "empty" };

const LETTER_WORDS = /\b(position|eliminat|terminat|severance|layoff|laid off|release|separation|last day|WARN|notice period|landlord|repair|violation|inspection)\b/i;

export function classifyInbound(subjectRaw: string, bodyRaw: string): Intent {
  const subject = cleanSubject(subjectRaw);
  const body = bodyRaw.replace(/\r/g, "").trim();
  const firstLine = (body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "").slice(0, 200);

  // A one-word command can arrive as the subject or as the first line of a
  // reply whose subject is ours. Check both.
  const commands = [firstLine, subject].map((s) => s.toLowerCase().replace(/[^a-z]+$/, ""));
  if (commands.some((c) => /^(follow|watch|subscribe|yes)$/.test(c))) return { kind: "follow" };
  if (commands.some((c) => /^(stop|unsubscribe|unfollow)$/.test(c))) return { kind: "stop" };

  // Paid requests arrive as "PACK <company or address>" and "MONITOR". Our own
  // subject comes back on every message in the thread once we have replied, so
  // inside a reply only the body may ask — otherwise "thanks" reads as a
  // second request and we build and send the whole pack again.
  const isReply = /^\s*(re|fwd|fw)\s*:/i.test(subjectRaw ?? "");
  const packMatch = (isReply ? null : /^pack\b[:\s-]*(.*)$/i.exec(subject)) ?? /^pack\b[:\s-]*(.*)$/i.exec(firstLine);
  if (packMatch) return { kind: "pack", query: packMatch[1].trim().slice(0, 120) };
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
