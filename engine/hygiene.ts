// Mail we must never answer. A reply to a bounce address, a newsletter, or an
// auto-responder starts a loop or burns the inbox's reputation — and the inbox
// is the product. RFC 3834 both ways: this detects auto-submitted mail coming
// in, and outbound replies carry Auto-Submitted so other robots leave us alone.

const ROBOT_LOCALPART =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounces?|bounce\+|notifications?|alerts?|newsletters?|news|digest|updates?|marketing|promo(tions?)?|billing|receipts?|invoices?|noc|abuse|list-?serv|majordomo|feedback|unsubscribe)([+@.:_-]|$)/i;

/** An address that is a machine, not a person. */
export function robotSender(address: string): boolean {
  const local = address.split("@")[0] ?? "";
  return ROBOT_LOCALPART.test(local);
}

/**
 * RFC 3834 / vendor markers on an inbound message. Headers may be absent from
 * the payload entirely — every read is defensive.
 */
export function isAutoSubmitted(headers: unknown): boolean {
  if (!headers || typeof headers !== "object") return false;
  const h: Record<string, string> = {};
  for (const [k, val] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof val === "string") h[k.toLowerCase()] = val.toLowerCase();
    else if (Array.isArray(val) && typeof val[0] === "string") h[k.toLowerCase()] = val[0].toLowerCase();
  }
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") return true;
  if (/\b(bulk|junk|list|auto_reply)\b/.test(h["precedence"] ?? "")) return true;
  if (h["x-auto-response-suppress"]) return true;
  if (h["x-autoreply"] || h["x-autorespond"]) return true;
  // List-Id marks a mailing list. List-Unsubscribe alone does NOT: providers
  // (AgentMail included) stamp it on ordinary person-sent API mail.
  if (h["list-id"]) return true;
  return false;
}

/**
 * The one gate: null means "a person we may answer", a string names why not.
 * The message is still stored either way — we just never send.
 */
export function skipReason(from: string, selfInbox: string, headers: unknown): string | null {
  if (!from || !from.includes("@")) return "no sender address";
  if (selfInbox && from.toLowerCase() === selfInbox.toLowerCase()) return "own inbox (loop)";
  if (robotSender(from)) return `robot sender (${from.split("@")[0]})`;
  if (isAutoSubmitted(headers)) return "auto-submitted mail";
  return null;
}
