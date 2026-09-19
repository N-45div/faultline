// The browser trial, as a conversation.
//
// gpt-live-1 listens and speaks at the same time, and is built to hand anything
// that needs thought to a backend. Here the backend is the inbox: when the
// voice model asks for help, the words the person just said go through the door
// a typed message uses - the same keyword reader, the same GPT-6 Astra agent,
// the same tools - and the reply the tool wrote is handed back to be said.
//
// Everywhere else the rule is that a model writes no sentence anyone reads or
// hears. A conversation cannot keep that to the letter: gpt-live-1 is trained
// to put a result into its own spoken words. So the rule here is the one that
// matters, and the page says so: nothing the voice says is the record. The
// written reply, in the thread beside it, is what the tool wrote and what is
// kept; the voice is told to add no fact to it, and knows none to add.
//
// This file is the part that needs no network: what the voice is told, how
// long a conversation may run, and how the fragments of a transcript become
// the message that goes through the door.

/** A conversation is billed by the second. Two and a half minutes is plenty to ask and answer, and the server ends it if the page does not. */
export const LIVE_MAX_SECONDS = 150;
/** gpt-live-1, per minute of conversation, in cents. */
export const LIVE_CENTS_PER_MINUTE = 5;

export const liveCents = (seconds: number): number => Math.round((Math.max(0, seconds) / 60) * LIVE_CENTS_PER_MINUTE * 100) / 100;

/** What the voice is told. It follows OpenAI's structure for a GPT-Live prompt: role, backchannels, interruptions, delegation. */
export const LIVE_INSTRUCTIONS = [
  "You are the voice of Faultline, a free service for New York City tenants. Faultline keeps the city's housing violation records, and asks tenants whether the repairs their landlord certified to the city were really done.",
  "Speak plainly, calmly and briefly, like a clerk reading a record back to the person it is about. Do not be cheerful. Do not give advice, legal or otherwise.",
  "You know nothing about any building, repair, violation, owner, company, date or law. Everything you say about them comes from the backend, and only from the backend.",
  "",
  "Backchannel policy: Use few backchannels. Let the person finish.",
  "",
  "Interruption policy: Stop speaking when the person interrupts. Listen to what they say.",
  "",
  "Delegation policy:",
  "Backend tools:",
  "- Building records: look up a New York City address and list the repairs its owner has certified to the city.",
  "- Answers: record whether a repair the person was asked about is fixed, still broken, or they are not sure, in their own words.",
  "- Company records: look up what a company filed with a state about layoffs.",
  "",
  "Delegate to the backend when:",
  "- The person gives an address, a building, a company name, or asks about repairs, violations or a record.",
  "- The person says anything about whether a repair was done, or describes the condition of something in their home.",
  "- The person corrects or changes something they said before.",
  "",
  "Do not delegate to the backend when:",
  "- The person only greets you, thanks you, or asks you to repeat a result you already gave.",
  "- You could not hear them. Ask them to say it again.",
  "",
  "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting; say only that you are checking the record.",
  "When a result arrives, say it in full and keep every number, date, name and count exactly as given. Add no fact, opinion or advice of your own. Read a violation number by its last four digits. Then stop and listen.",
  "If asked what you are: an automated voice for Faultline. The written replies on the page are the record; what you say is not.",
].join("\n");

/** Said first, exactly: who is speaking, that it is automated, and what to say. */
export const LIVE_GREETING =
  'Immediately say the following exactly and in full, then pause and listen: "This is Faultline\'s automated voice. Tell me a New York City address, or answer a question I have asked you. The written replies on the page are the record."';

export type Fragment = { delta: string; start_ms: number; end_ms: number };

/**
 * What the person said since the last thing we sent through the door. The
 * fragments are joined exactly as they arrived - they carry their own spaces -
 * and only then tidied. A request for help carries no words of its own, so
 * this is the message.
 */
export function utterance(fragments: Fragment[], sinceMs: number): { text: string; untilMs: number } {
  const mine = fragments.filter((f) => f.end_ms > sinceMs).sort((a, b) => a.start_ms - b.start_ms);
  const text = mine
    .map((f) => f.delta)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  return { text, untilMs: mine.reduce((m, f) => Math.max(m, f.end_ms), sinceMs) };
}

/**
 * A spoken command, as the keyword reader would want it typed. The voice asks
 * for an address, so an address is what people say - "155 Linden Boulevard",
 * "about 155 Linden Boulevard", "I live at 155 Linden Boulevard, Brooklyn" -
 * and a transcriber drops a first short word as often as not ("Ask about…"
 * arrived as "About…" the first time this ran). In a conversation an address
 * means one thing: ask me about the repairs there. A transcriber also ends
 * every sentence with a full stop. Anything else goes through as it was said.
 */
export function spokenToTyped(words: string): string {
  const w = words.replace(/\s+/g, " ").trim();
  const lead = /^(?:(?:please|can you|could you|ask|tell|check|look up|me|us|about|it is|it's|its|i live at|i live in|i'm at|i am at|my address is|my building is|the address is|at|for)[\s,:-]+)+/i;
  const rest = w.replace(lead, "");
  // A house number, then within a few words something only an address has: a kind of street, a borough, "12th".
  const streetish = /\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|place|pl|drive|dr|court|ct|lane|ln|parkway|pkwy|terrace|way|broadway|concourse|highway|plaza|square|walk|loop|turnpike|expressway|bowery|brooklyn|bronx|manhattan|queens|staten island|\d+(?:st|nd|rd|th))\b/i;
  if (/^\d+[a-z]?(?:-\d+)?\s+\S+/i.test(rest) && rest.split(" ").length <= 12 && streetish.test(rest)) return `ASK ${rest.replace(/[.?!]+$/, "").trim()}`;
  const ask = /^(?:please\s+)?ask\b[\s,:-]*(?:me\s+)?(?:about\s+)?(.+)$/i.exec(w);
  if (ask) return `ASK ${ask[1].replace(/[.?!]+$/, "").trim()}`;
  return w;
}
