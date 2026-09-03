// The kill switch. One deployment variable, read at the top of every path
// that spends money or sends mail, so judging week has a way to stop one
// thing without stopping everything:
//
//   npx convex env set --prod NOTICE_PAUSE mail        # hold every email
//   npx convex env set --prod NOTICE_PAUSE llm,ingest  # stop the model and the reads
//   npx convex env set --prod NOTICE_PAUSE all
//   npx convex env remove --prod NOTICE_PAUSE
//
// A paused email is queued, not dropped; a paused read is skipped and picked
// up at the next tick; a paused model call answers "we didn't look".

export type Pausable = "mail" | "ingest" | "llm";

export function pausedSet(): Set<string> {
  return new Set(
    (process.env.NOTICE_PAUSE ?? "")
      .toLowerCase()
      .split(/[,\s]+/)
      .filter(Boolean),
  );
}

export function paused(what: Pausable): boolean {
  const p = pausedSet();
  return p.has("all") || p.has(what);
}

/**
 * Whether a failure is the provider's rather than ours. A 4xx means we built a
 * bad request, or that one message is unsendable — counting those would let
 * three ordinary faults switch a provider off for everybody. A 5xx, a 429, an
 * auth rejection or a network error is the provider being unavailable.
 */
export function providerFault(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (typeof status === "number") return status >= 500 || status === 429 || status === 401 || status === 403;
  const m = /\b(\d{3})\b/.exec(String((e as Error)?.message ?? ""));
  if (!m) return true;
  const code = Number(m[1]);
  return code >= 500 || code === 429 || code === 401 || code === 403;
}
