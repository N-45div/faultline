"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { adapters } from "../../engine/adapters/index";
import { hashFields, sha256Hex } from "../../engine/canon";
import { diffRows } from "../../engine/diff";
import type { DiffResult, FetchBody, Observation, PrevIndex, SourceAdapter } from "../../engine/types";
import { scrapePage } from "./firecrawl";

// The one place bytes from the outside world are touched. Parse, hash and diff
// here; hand the mutation only what it needs to write.

const UA = "Faultline/0.1 (+https://github.com/N-45div/faultline; keeps dated copies of public filings)";
const CURSOR_TRAIL_DAYS = 3;
// A cycle is written in slices. Each row costs about four database operations,
// so a slice this size stays far inside what one Convex function may do; the
// cycle is many slices, driven from here.
const ROWS_PER_BATCH = 150;
// How many rows one cycle will write at all. Whatever is left over still
// differs from `current` next cycle, so it is written then, not lost.
const MAX_ROWS_PER_CYCLE = 3000;
// The "before" side is read in slices too, for the same reason: a closed-world
// source asks for one row per key it fetched, and a city fetches thousands.
// Sixty, not 250: a query has one second, and 250 point lookups on a cold
// deployment ran past it — "too many system operations", five cycles running.
const PREV_KEYS_PER_QUERY = 60;

export const runSource = internalAction({
  args: { slug: v.string() },
  returns: v.null(),
  handler: async (ctx, { slug }) => {
    const adapter = adapters[slug];
    if (!adapter) throw new Error(`no adapter for ${slug}`);
    const source = await ctx.runQuery(internal.ingest.write.getBySlug, { slug });
    if (!source) throw new Error(`no source row for ${slug}`);

    const startedAt = Date.now();
    try {
      const fetched = await fetchSource(ctx, adapter, source);
      const next = {
        nextRunAt: startedAt + jitter(adapter.cadence.baseMs, adapter.cadence.jitterPct),
        cursor: fetched.cursor,
        lastStatus: fetched.kind === "unchanged" ? "304 unchanged" : `${fetched.status} · ${fetched.rowCount} rows`,
      };

      if (fetched.kind === "unchanged") {
        await ctx.runMutation(internal.ingest.write.beginCommit, {
          sourceId: source._id,
          snapshot: {
            capturedAt: startedAt,
            requestUrl: fetched.url,
            httpStatus: 304,
            etag: fetched.etag,
            bodySha256: source.lastBodySha256 ?? "",
            rowCount: 0,
            degraded: false,
          },
        });
        await ctx.runMutation(internal.ingest.write.finishCommit, {
          sourceId: source._id,
          capturedAt: startedAt,
          bodySha256: source.lastBodySha256 ?? "",
          etag: fetched.etag,
          next,
        });
        return null;
      }

      const observations = await toObservations(adapter, fetched.body, fetched.bodySha256, startedAt);
      next.lastStatus = `${fetched.status} · ${observations.length} rows`;

      // A 200 that parses to nothing is a broken read, not an empty file: a
      // state redesigned its page, a header row moved, a sheet lost its public
      // sharing. Recorded as a failure, so the tour shows it — otherwise the
      // source keeps its old row count and its fresh timestamp and reads as
      // "97 rows, verified" while it has ingested nothing for days.
      if (observations.length === 0) {
        // Thrown, so it takes the same backoff and the same failure counter as
        // any other broken read.
        throw new Error(`HTTP ${fetched.status} parsed to 0 rows`);
      }

      // The "before" side, read in slices — a city asks about thousands of rows.
      const prev: PrevIndex = {};
      const mode = adapter.presence === "open_world" ? "all" : "keys";
      const keyBatches: string[][] = [];
      if (mode === "all") keyBatches.push([]);
      else {
        // A file can carry the same row twice; asking twice costs twice.
        const unique = [...new Set(observations.map((o) => o.identityKey))];
        for (let i = 0; i < unique.length; i += PREV_KEYS_PER_QUERY) keyBatches.push(unique.slice(i, i + PREV_KEYS_PER_QUERY));
      }
      for (const identityKeys of keyBatches) {
        const rows = await ctx.runQuery(internal.ingest.write.prevFor, { sourceId: source._id, mode, identityKeys });
        for (const r of rows) prev[r.identityKey] = { sigHash: r.sigHash, fullHash: r.fullHash, fields: {} };
      }
      // The diff reads a previous row's fields only when the row moved or
      // left the file. Fetch exactly those, in slices; unchanged rows — nearly
      // all of them — never leave the database.
      const seen = new Map(observations.map((o) => [o.identityKey, o.sigHash] as const));
      const needFields = Object.entries(prev)
        .filter(([key, p]) => !seen.has(key) || seen.get(key) !== p.sigHash)
        .map(([key]) => key);
      for (let i = 0; i < needFields.length; i += PREV_KEYS_PER_QUERY) {
        const rows = await ctx.runQuery(internal.ingest.write.prevFields, { sourceId: source._id, identityKeys: needFields.slice(i, i + PREV_KEYS_PER_QUERY) });
        for (const r of rows) if (prev[r.identityKey]) prev[r.identityKey]!.fields = r.fields;
      }

      const diff = diffRows(adapter, prev, observations);
      const allNew = observations.filter((o) => !prev[o.identityKey] || prev[o.identityKey].fullHash !== o.fullHash);
      const newVersions = allNew.slice(0, MAX_ROWS_PER_CYCLE);
      const kept = new Set(newVersions.map((o) => o.identityKey));
      if (allNew.length > newVersions.length) console.warn(`[${slug}] ${allNew.length - newVersions.length} rows deferred to next cycle`);

      // Pin the exact bytes only when they proved something moved — and only
      // for a whole file. A server-filtered source's "body" is a slice we
      // composed ourselves, not the state's file; every row of it is already
      // held as an observation, and pinning two megabytes of it every fifteen
      // minutes is what filled the free plan's file storage on 4 September.
      let bodyStorageId: string | undefined;
      if (diff.changes.length > 0 && adapter.targeting === "whole_file") {
        bodyStorageId = await ctx.storage.store(new Blob([fetched.bytes as BlobPart], { type: "application/octet-stream" }));
      }

      const snapshotId = await ctx.runMutation(internal.ingest.write.beginCommit, {
        sourceId: source._id,
        snapshot: {
          capturedAt: startedAt,
          requestUrl: fetched.url,
          httpStatus: fetched.status,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
          bodySha256: fetched.bodySha256,
          bodyStorageId: bodyStorageId as any,
          rowCount: observations.length,
          degraded: diff.degraded,
        },
      });

      // A change travels in the same slice as the row it describes, so a slice
      // that never runs leaves both undone — and the next cycle finds the row
      // still changed and writes both together.
      const changesByKey = new Map<string, ReturnType<typeof toChangeArg>[]>();
      const removed: ReturnType<typeof toChangeArg>[] = [];
      for (const c of diff.changes) {
        const arg = toChangeArg(c);
        if (c.kind === "removed") removed.push(arg);
        else if (kept.has(c.identityKey)) changesByKey.set(c.identityKey, [...(changesByKey.get(c.identityKey) ?? []), arg]);
      }

      let wrote = 0;
      let emitted = 0;
      let emittedFlag = false;
      for (let i = 0; i < newVersions.length; i += ROWS_PER_BATCH) {
        const slice = newVersions.slice(i, i + ROWS_PER_BATCH);
        const result = await ctx.runMutation(internal.ingest.write.commitBatch, {
          sourceId: source._id,
          snapshotId,
          capturedAt: startedAt,
          observations: slice.map((o) => ({
            identityKey: o.identityKey,
            subject: o.subject,
            claimKind: o.claimKind,
            assertedAt: o.assertedAt,
            fields: o.fields,
            sigHash: o.sigHash,
            fullHash: o.fullHash,
          })),
          changes: slice.flatMap((o) => changesByKey.get(o.identityKey) ?? []),
          sourceUrl: adapter.pageUrl ?? adapter.datasetUrl,
        });
        wrote += result.observations;
        emitted += result.changes;
        emittedFlag = result.emitted;
      }
      // Rows that left the file carry no new version, so they go last, alone.
      for (let i = 0; i < removed.length; i += ROWS_PER_BATCH) {
        const result = await ctx.runMutation(internal.ingest.write.commitBatch, {
          sourceId: source._id,
          snapshotId,
          capturedAt: startedAt,
          observations: [],
          changes: removed.slice(i, i + ROWS_PER_BATCH),
          sourceUrl: adapter.pageUrl ?? adapter.datasetUrl,
        });
        emitted += result.changes;
        emittedFlag = result.emitted;
      }

      // When rows were deferred, the etag is deliberately not stored: keeping
      // it would make the next cycle send If-None-Match, get a 304 for bytes
      // that have not changed, write nothing, and leave the deferred rows
      // waiting until the state next edits the file.
      const deferred = allNew.length > newVersions.length;
      if (deferred) next.nextRunAt = Date.now();
      await ctx.runMutation(internal.ingest.write.finishCommit, {
        sourceId: source._id,
        capturedAt: startedAt,
        bodySha256: fetched.bodySha256,
        etag: fetched.etag,
        clearEtag: deferred,
        next,
      });
      console.log(
        `[${slug}] ${fetched.status} rows=${observations.length} new=${wrote} changes=${emitted}` +
          ` silent=${diff.silentUpdates} suppressed=${diff.suppressed} degraded=${diff.degraded} emit=${emittedFlag}`,
      );
    } catch (e) {
      const failures = source.consecutiveFailures + 1;
      const retryInMs = Math.min(adapter.cadence.baseMs * 2 ** Math.min(failures, 4), 6 * 3_600_000);
      console.error(`[${slug}] failed: ${String(e)} — retry in ${Math.round(retryInMs / 60_000)}m`);
      await ctx.runMutation(internal.ingest.write.fail, { sourceId: source._id, error: String(e), retryInMs });
    }
    return null;
  },
});

function toChangeArg(c: DiffResult["changes"][number]) {
  return {
    identityKey: c.identityKey,
    subjectKey: c.subject.key,
    kind: c.kind,
    changed: c.changed,
    before: "before" in c ? c.before : undefined,
    after: "after" in c ? c.after : undefined,
    sentence: c.sentence,
  };
}

type Fetched =
  | { kind: "unchanged"; url: string; etag?: string; cursor?: string }
  | {
      kind: "body";
      url: string;
      status: number;
      etag?: string;
      lastModified?: string;
      bytes: Uint8Array;
      bodySha256: string;
      body: FetchBody;
      rowCount: number;
      cursor?: string;
    };

async function fetchSource(
  ctx: { runQuery: any; runMutation: any; runAction: any },
  adapter: SourceAdapter<any>,
  source: { _id: any; cursor?: string; lastEtag?: string },
): Promise<Fetched> {
  const t = adapter.transport;
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "*/*" };
  const fetchedAt = new Date().toISOString();

  if (t.kind === "socrata") {
    const keys: string[] = await ctx.runQuery(internal.ingest.write.targetKeys, { sourceId: source._id });
    const cursor = daysAgoIso(CURSOR_TRAIL_DAYS);
    if (keys.length === 0) {
      return { kind: "unchanged", url: adapter.datasetUrl, cursor };
    }
    const rows: unknown[] = [];
    let lastUrl = "";
    for (let i = 0; i < keys.length; i += t.maxKeysPerQuery) {
      const chunk = keys.slice(i, i + t.maxKeysPerQuery);
      lastUrl = encodeURI(`https://${t.domain}/resource/${t.resourceId}.json?${t.watch(chunk, cursor)}`);
      const res = await fetch(lastUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${t.domain}`);
      const page = JSON.parse(await res.text());
      if (Array.isArray(page)) rows.push(...page);
    }
    const text = JSON.stringify(rows);
    const bytes = new TextEncoder().encode(text);
    return {
      kind: "body",
      url: lastUrl,
      status: 200,
      bytes,
      bodySha256: await sha256Hex(bytes),
      body: { kind: "text", text, status: 200, url: lastUrl, fetchedAt },
      rowCount: rows.length,
      cursor,
    };
  }

  if (t.kind === "http_text" || t.kind === "http_binary") {
    if (t.kind === "http_binary" && t.conditional.etag && source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    // A state that renames its file on every publish links to it from one page
    // that does not move. Read that page first; fall back to the last URL we
    // knew if it cannot be read, so a redesign degrades rather than breaks.
    let url = t.url;
    if (t.kind === "http_text" && t.discover) {
      try {
        const page = await fetch(t.discover.pageUrl, { headers });
        if (page.ok) {
          const found = t.discover.find(await page.text());
          if (found) url = found;
          else console.warn(`[${adapter.id}] discovery page had no link; using the last URL we knew`);
        }
      } catch (e) {
        console.warn(`[${adapter.id}] discovery failed (${String(e)}); using the last URL we knew`);
      }
    }

    const res = await fetch(url, { headers });
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (res.status === 304) return { kind: "unchanged", url, etag: etag ?? source.lastEtag };
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const body: FetchBody =
      t.kind === "http_binary"
        ? { kind: "bytes", bytes, status: res.status, url, fetchedAt, etag, lastModified }
        : { kind: "text", text: new TextDecoder().decode(bytes), status: res.status, url, fetchedAt, etag, lastModified };
    return { kind: "body", url, status: res.status, etag, lastModified, bytes, bodySha256: await sha256Hex(bytes), body, rowCount: -1 };
  }

  if (t.kind === "firecrawl_scrape") {
    // Fetched by Firecrawl from their side, not ours. The adapter parses the
    // page's HTML exactly as it would a file we fetched directly; the only
    // difference is who did the fetching, and that is recorded in the URL.
    const page = await scrapePage(ctx, t.url);
    const bytes = new TextEncoder().encode(page.html);
    return {
      kind: "body",
      url: page.url,
      status: page.status,
      bytes,
      bodySha256: await sha256Hex(bytes),
      body: { kind: "text", text: page.html, status: page.status, url: page.url, fetchedAt },
      rowCount: -1,
    };
  }

  // Every transport kind is handled above; this is the compiler's proof.
  const never: never = t;
  throw new Error(`transport ${String((never as { kind?: string }).kind)} not wired`);
}

async function toObservations(adapter: SourceAdapter<any>, body: FetchBody, bodySha256: string, capturedAt: number): Promise<Observation[]> {
  const out: Observation[] = [];
  const requestedAt = new Date(capturedAt).toISOString();
  for (const raw of adapter.parse(body)) {
    const fields = adapter.normalise(raw);
    const identityKey = adapter.identity(raw);
    out.push({
      identityKey,
      subject: adapter.subjectOf(raw),
      claimKind: adapter.claimKind,
      assertedAt: adapter.assertedAt(raw),
      capturedAt: requestedAt,
      fields,
      sigHash: await hashFields(fields, adapter.noise, adapter.significant),
      fullHash: await hashFields(fields, adapter.noise),
      provenance: {
        sourceId: adapter.id,
        adapterVersion: adapter.version,
        requestUrl: body.url,
        requestedAt,
        httpStatus: body.status,
        etag: "etag" in body ? body.etag : undefined,
        bodySha256,
        rowLocator: identityKey,
      },
    });
  }
  return out;
}

function jitter(baseMs: number, pct: number): number {
  const spread = baseMs * (pct / 100);
  return Math.round(baseMs + (Math.random() * 2 - 1) * spread);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
