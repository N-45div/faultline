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
