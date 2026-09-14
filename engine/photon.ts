// Photon's webhook, checked the way its docs say: HMAC-SHA256 over
// "v0:{timestamp}:{rawBody}", keyed by the webhook's signing secret, sent as
// "v0=" and lowercase hex, and only inside five minutes of the timestamp. Web
// Crypto only, so it runs in Convex's default runtime and in the tests.

export const PHOTON_TOLERANCE_SEC = 5 * 60;

export type SignatureCheck = "ok" | "missing" | "stale" | "bad";

export async function verifySpectrumSignature(p: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSec: number;
}): Promise<SignatureCheck> {
  if (!p.timestamp || !p.signature) return "missing";
  const ts = Number(p.timestamp);
  if (!Number.isFinite(ts) || Math.abs(p.nowSec - ts) > PHOTON_TOLERANCE_SEC) return "stale";
  const expected = await spectrumSignature(p.secret, p.timestamp, p.rawBody);
  return constantTimeEqual(expected, p.signature.trim().toLowerCase()) ? "ok" : "bad";
}

/** The header value Photon sends for this body at this timestamp. */
export async function spectrumSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`) as BufferSource);
  return "v0=" + Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A texter's identity everywhere an email address would be: answers, follows,
 * private records. The prefix keeps a phone number from ever being mailed.
 */
export const PHOTON_PREFIX = "photon:";

export function photonIdentity(handle: string): string {
  return `${PHOTON_PREFIX}${handle}`;
}

export function isPhotonIdentity(identity: string): boolean {
  return identity.startsWith(PHOTON_PREFIX);
}

/** "any;-;+15550100" or "photon:+15550100" becomes "+15550100". */
export function handleOf(spaceOrIdentity: string): string {
  const s = isPhotonIdentity(spaceOrIdentity) ? spaceOrIdentity.slice(PHOTON_PREFIX.length) : spaceOrIdentity;
  return s.includes(";") ? s.slice(s.lastIndexOf(";") + 1) : s;
}
