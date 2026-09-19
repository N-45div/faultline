// The browser trial. A third way in, beside email and text, for someone who
// will not send either: a judge with ninety seconds, a tenant on a library
// computer. The same handler reads it and the same tools answer it; what
// differs is where the reply goes (a live query, not a mailbox) and what it may
// never touch. A trial has no mailbox, so it cannot follow, be emailed, or
// receive an attachment; and because anyone can open one, what is said in it is
// kept on the trial's own page and never counted on a public one.

export const WEB_CHANNEL = "web";

/** Made in the browser, held in the browser: the only key to a trial's thread. */
export function validSession(session: string): boolean {
  return /^[a-f0-9]{32,64}$/.test(session);
}

export function webIdentity(session: string): string {
  return `web:${session}`;
}

export function isWeb(identity: string): boolean {
  return identity.startsWith("web:");
}
