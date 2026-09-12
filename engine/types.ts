// Pure engine. Lives outside convex/ so only the Node action that imports it
// pulls in the xlsx parser; nothing here is bundled for the V8 runtime.
// Pure types. No Convex imports anywhere under convex/engine — everything here
// runs on fixture bytes in a plain node test before it ever touches a deployment.

export type Scalar = string | number | boolean | null;
export type Fields = Record<string, Scalar>;
/** ISO-8601. Date-only ("2026-08-25") when the source itself is date-only. */
export type Iso = string;

export interface SubjectRef {
  kind: "building" | "employer_site";
  /** Stable key: a BBL, or employer|site slug. */
  key: string;
  /** Public-safe label: an address or an employer + site. Never a unit number. */
  label: string;
}

export type FetchBody =
  | { kind: "text"; text: string; status: number; url: string; fetchedAt: Iso; etag?: string; lastModified?: string }
  | { kind: "bytes"; bytes: Uint8Array; status: number; url: string; fetchedAt: Iso; etag?: string; lastModified?: string }
  | { kind: "unchanged"; status: 304; url: string; fetchedAt: Iso; etag?: string };

/** Applied to a copy of the fields before hashing. Stored fields are untouched. */
export type NoiseRule =
  | { op: "drop"; path: string }
  | { op: "trimCase"; path: string }
  | { op: "round"; path: string; decimals: number }
  | { op: "dateOnly"; path: string }
  | { op: "replace"; path: string; pattern: string; flags?: string; with: string };

export type SuppressRule =
  | { op: "delta_below"; path: string; min: number }
  | { op: "flap"; path: string; windowMs: number };

export type Transport =
  | {
      kind: "socrata";
      domain: string;
      resourceId: string;
      maxKeysPerQuery: number;
      /** A cheap count query: is anything happening since the cursor? */
      pulse: (cursorIso: string) => string;
      /** Only the subjects somebody is actually looking at. */
      watch: (subjectKeys: string[], cursorIso: string) => string;
    }
  | {
      kind: "http_text";
      url: string;
      format: "csv" | "json" | "html";
      rejectIfMatches: string[];
      /**
       * Some states publish the file at a new path every time they publish it,
       * and link to it from one stable page. Given that page, `find` returns
       * today's URL; `url` above is the last one we knew about, used only if
       * the page cannot be read.
       */
      discover?: { pageUrl: string; find: (html: string) => string | null };
    }
  | { kind: "http_binary"; url: string; decode: "xlsx"; conditional: { etag: true; treat304As: "no_change" } }
  | { kind: "firecrawl_scrape"; url: string; formats: ("markdown" | "json")[]; creditsPerFetch: number };

export interface SourceAdapter<Raw = Fields> {
  id: string;
  version: number;
  publisher: string;
  jurisdiction: string;
  datasetUrl: string;
  /** Where to send a person to check it themselves — some datasetUrls are JSON. */
  pageUrl?: string;
  transport: Transport;
  cadence: { baseMs: number; hotMs: number; jitterPct: number; gate: "always" | "when_watched" };
  targeting: "server_filter" | "whole_file";
  subjectKind: SubjectRef["kind"];
  claimKind: string;
  /** Runs in an action, never a mutation. */
  parse(body: FetchBody): Raw[];
  /** The diff unit. No stable identity, no adapter. */
  identity(raw: Raw): string;
  subjectOf(raw: Raw): SubjectRef;
  /** The date the record itself bears — never the capture time. */
  assertedAt(raw: Raw): Iso;
  normalise(raw: Raw): Fields;
  /** Only these paths can emit a change. Everything else is stored silently. */
  significant: string[];
  noise: NoiseRule[];
  suppress?: SuppressRule[];
  /**
   * Whole-file sources can prove absence; server-filtered slices cannot —
   * except a slice that is exhaustive per subject: when every row for a
   * building is fetched every time, a row we hold for that building that is
   * no longer returned has left the file. "subject_world" says so.
   */
  presence: "closed_world" | "open_world" | "subject_world";
  /** How to say a row left the file, in the record's own words. Optional; a plain sentence otherwise. */
  renderRemoved?(before: Fields): string;
  /** The timeline sentence. Templated from the record's own words. No model. */
  render(after: Fields, before?: Fields): string;
  /** Below minRows the cycle is degraded: record nothing as removed. */
  health: { minRows: number; expectedKeys: string[] };
  budget: { credits: number; maxFetchesPerDay: number };
}

export interface Provenance {
  sourceId: string;
  adapterVersion: number;
  requestUrl: string;
  requestedAt: Iso;
  httpStatus: number;
  etag?: string;
  lastModified?: string;
  bodySha256: string;
  rowLocator: string;
}

export interface Observation {
  identityKey: string;
  subject: SubjectRef;
  claimKind: string;
  assertedAt: Iso;
  capturedAt: Iso;
  fields: Fields;
  sigHash: string;
  fullHash: string;
  provenance: Provenance;
}

export interface PrevRow {
  sigHash: string;
  fullHash: string;
  fields: Fields;
}
export type PrevIndex = Record<string, PrevRow>;

export type Change =
  | { kind: "added"; identityKey: string; subject: SubjectRef; after: Fields; changed: string[]; sentence: string }
  | { kind: "changed"; identityKey: string; subject: SubjectRef; before: Fields; after: Fields; changed: string[]; sentence: string }
  | { kind: "removed"; identityKey: string; subject: SubjectRef; before: Fields; changed: string[]; sentence: string };

export interface DiffResult {
  changes: Change[];
  /** Rows whose fullHash moved but sigHash did not: store, do not emit. */
  silentUpdates: number;
  unchanged: number;
  degraded: boolean;
  suppressed: number;
}
