// A receipt, read aloud.
//
// The reply a person reads is written by the tools, and the one they hear is the
// same reply: nothing is composed for the ear by a model. But a page and a voice
// are different readers. A web address is noise out loud, a statute citation is
// worse, a violation number read as "nineteen million" is useless, and the
// city writes its descriptions in capitals that a voice spells letter by letter.
// This turns the written reply into the one worth listening to, and nothing in
// it is new: every word that is spoken is on the page.

/** About forty seconds of speech. Past this a listener has stopped listening. */
export const SPOKEN_MAX = 640;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** 2026-11-26 -> "November 26". The year is the one they are living in. */
export function sayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : iso;
}

/** THE BROKEN OR DEFECTIVE VINYL FLOOR TILES -> the broken or defective vinyl floor tiles. */
function sayShouted(text: string): string {
  return text.replace(/\b[A-Z][A-Z'/&-]*(?:\s+[A-Z0-9][A-Z0-9'/&-]*)+\b/g, (run) => run.toLowerCase());
}

/**
 * The city cuts its descriptions off mid-word and we print them as it does,
 * with an ellipsis. Out loud, the half word and whatever little word was left
 * dangling before it ("in the", "at") are dropped: a voice cannot say "locat".
 */
function sayWhole(described: string): string {
  let d = described.replace(/\s*\S*…\s*$/, "").trim();
  while (/\s(?:IN|AT|OF|ON|TO|THE|AND|OR|A|AN|FROM|WITH)$/i.test(d)) d = d.replace(/\s\S+$/, "");
  return d;
}

/**
 * One of the city's descriptions, as a clause a voice can say: without the
 * citation in front of it, without the word the city cut in half, in lower case.
 */
export function sayCondition(described: string): string {
  const whole = /…/.test(described) ? sayWhole(described) : described.trim();
  return whole
    .replace(/§\s*[\d\-,\s]+(?:ADM CODE|HMC:?|M\/D LAW)?(?:\s*&\s*\d+\s*M\/D LAW)?\s*/gi, "")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.;,\s]+$/, "");
}

export function forSpeech(written: string): string {
  const lines = written
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    // A line that exists to carry a link says nothing out loud.
    .filter((l) => !/https?:\/\//i.test(l))
    // Nor does the line about replying with another company, which is about email.
    .filter((l) => !/^Reply with another company name/i.test(l));

  let text = lines.join("\n");
  // The city's own words sit in quotation marks; finish each before anything else touches it.
  text = text.replace(/[“"]([^"”\n]*…[^"”\n]*)[”"]/g, (_, d: string) => `"${sayWhole(d)}"`);
  // On the page each repair carries the city's status in the city's words, because
  // a reader checks it. A listener needs the claim and its date, once.
  text = text.replace(/The owner certified this corrected: NOV CERTIFIED (ON TIME|LATE) as of (\d{4}-\d{2}-\d{2})\./g, (_, when: string, date: string) =>
    when === "LATE" ? `The owner certified this corrected, late, on ${date}.` : `The owner certified this corrected on ${date}.`,
  );
  // The address is said with the first repair; after that the listener knows where they are.
  let placed = false;
  text = text.replace(/(#\s?\d{5,10}) at [^(\n]+?(\(class [ABC]\))/g, (whole: string, id: string, cls: string) => {
    if (!placed) {
      placed = true;
      return whole;
    }
    return `${id} ${cls}`;
  });
  // NOV is the city's code for a notice of violation, and a voice reads it as a month.
  text = text.replace(/\bNOV\b/g, "notice of violation");
  // The city's citation before its own words: "§ 27-2005 ADM CODE", "§ 27-2026, 2027 HMC:", "& 309 M/D LAW".
  text = text.replace(/§\s*[\d\-,\s]+(?:ADM CODE|HMC:?|M\/D LAW)?(?:\s*&\s*\d+\s*M\/D LAW)?\s*/gi, "");
  // A violation number is said by its last four digits, which is how two people would say it.
  text = text.replace(/#\s?(\d{5,10})\b/g, (_, id: string) => `violation ending ${id.slice(-4).split("").join(" ")}`);
  text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => sayDate(d));
  text = sayShouted(text);
  text = text
    .replace(/\bHPD\b/g, "H P D")
    .replace(/\(class ([ABC])\)/gi, ", class $1,")
    .replace(/[“”"]/g, "")
    .replace(/…/g, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/^\s*-\s+/gm, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\.{2,}/g, ".")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  if (text.length <= SPOKEN_MAX) return text;
  // End on a sentence, and say that there is more on the page.
  const cut = text.slice(0, SPOKEN_MAX);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("? "));
  return `${cut.slice(0, stop > 200 ? stop + 1 : SPOKEN_MAX).trim()} The rest is on the page.`;
}
