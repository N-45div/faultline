import type { Change, DiffResult, Fields, Observation, PrevIndex, SourceAdapter, SuppressRule } from "./types";
import { canonicalise } from "./canon";

/**
 * The unit of change is a row identity, never a response body. Two captures of
 * att.com/outages produce two different bodies and zero changes here.
 */
export function diffRows(
  adapter: Pick<SourceAdapter<any>, "significant" | "noise" | "suppress" | "presence" | "health" | "render" | "renderRemoved">,
  prev: PrevIndex,
  next: Observation[],
  opts: { trustAbsence?: boolean } = {},
): DiffResult {
  const degraded = next.length < adapter.health.minRows;
  const changes: Change[] = [];
  let silentUpdates = 0;
  let unchanged = 0;
  let suppressed = 0;
  const seen = new Set<string>();

  for (const obs of next) {
    seen.add(obs.identityKey);
    const before = prev[obs.identityKey];
    if (!before) {
      changes.push({
        kind: "added",
        identityKey: obs.identityKey,
        subject: obs.subject,
        after: obs.fields,
        changed: [...adapter.significant],
        sentence: adapter.render(obs.fields),
      });
      continue;
    }
    if (before.sigHash === obs.sigHash) {
      if (before.fullHash !== obs.fullHash) silentUpdates++;
      else unchanged++;
      continue;
    }
    const changed = changedPaths(before.fields, obs.fields, adapter.significant, adapter.noise);
    if (isSuppressed(adapter.suppress ?? [], before.fields, obs.fields, changed)) {
      suppressed++;
      continue;
    }
    changes.push({
      kind: "changed",
      identityKey: obs.identityKey,
      subject: obs.subject,
      before: before.fields,
      after: obs.fields,
      changed,
      sentence: adapter.render(obs.fields, before.fields),
    });
  }

  // Absence is only a fact when the whole file was seen and looked healthy —
  // or, for a slice that is exhaustive per subject, when the read was not
  // truncated. One captcha page must never become "192 filings vanished".
  const absenceProvable = (adapter.presence === "open_world" || adapter.presence === "subject_world") && !degraded && opts.trustAbsence !== false;
  if (absenceProvable) {
    for (const identityKey of Object.keys(prev)) {
      if (seen.has(identityKey)) continue;
      const before = prev[identityKey];
      changes.push({
        kind: "removed",
        identityKey,
        subject: subjectFromFields(before.fields),
        before: before.fields,
        changed: [],
        sentence: adapter.renderRemoved ? adapter.renderRemoved(before.fields) : renderRemoved(before.fields),
      });
    }
  }

  return { changes, silentUpdates, unchanged, degraded, suppressed };
}

export function changedPaths(before: Fields, after: Fields, significant: string[], noise: SourceAdapter["noise"]): string[] {
  const b = canonicalise(before, noise, significant);
  const a = canonicalise(after, noise, significant);
  return significant.filter((p) => b[p] !== a[p]);
}

function isSuppressed(rules: SuppressRule[], before: Fields, after: Fields, changed: string[]): boolean {
  for (const rule of rules) {
    if (rule.op === "delta_below") {
      if (changed.length === 1 && changed[0] === rule.path) {
        const b = Number(before[rule.path]);
        const a = Number(after[rule.path]);
        if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < rule.min) return true;
      }
    }
    // "flap" needs the previous two observations, which live in the database;
    // it is applied at write time, not here.
  }
  return false;
}

function subjectFromFields(f: Fields) {
  return {
    kind: (String(f.__subjectKind ?? "employer_site") as "building" | "employer_site"),
    key: String(f.__subjectKey ?? ""),
    label: String(f.__subjectLabel ?? ""),
  };
}

function renderRemoved(f: Fields): string {
  const label = String(f.__subjectLabel ?? "a record");
  return `${label} is no longer in the file. We kept the version that had it.`;
}
