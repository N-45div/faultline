"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { adapters } from "../../engine/adapters/index";
import { hashFields, sha256Hex } from "../../engine/canon";
import { diffRows } from "../../engine/diff";
import type { FetchBody, Observation, PrevIndex, SourceAdapter } from "../../engine/types";

// The one place bytes from the outside world are touched. Parse, hash and diff
// here; hand the mutation only what it needs to write.

const UA = "Notice/0.1 (+https://github.com/N-45div/notice; keeps dated copies of public filings)";
const CURSOR_TRAIL_DAYS = 3;
// One transaction stays well inside Convex's write limits; anything past the
// cap is picked up next cycle as a plain addition.
const MAX_ROWS_PER_COMMIT = 1200;

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
        await ctx.runMutation(internal.ingest.write.commit, {
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
          observations: [],
          changes: [],
          sourceUrl: adapter.datasetUrl,
          next,
        });
        return null;
      }

      const observations = await toObservations(adapter, fetched.body, fetched.bodySha256, startedAt);
      next.lastStatus = `${fetched.status} · ${observations.length} rows`;
      const prevRows = await ctx.runQuery(internal.ingest.write.prevFor, {
        sourceId: source._id,
        mode: adapter.presence === "open_world" ? "all" : "keys",
        identityKeys: observations.map((o) => o.identityKey),
      });
      const prev: PrevIndex = Object.fromEntries(
        prevRows.map((r) => [r.identityKey, { sigHash: r.sigHash, fullHash: r.fullHash, fields: r.fields }]),
      );
      const diff = diffRows(adapter, prev, observations);
      const allNew = observations.filter((o) => !prev[o.identityKey] || prev[o.identityKey].fullHash !== o.fullHash);
      const newVersions = allNew.slice(0, MAX_ROWS_PER_COMMIT);
      const kept = new Set(newVersions.map((o) => o.identityKey));
      if (allNew.length > newVersions.length) console.warn(`[${slug}] ${allNew.length - newVersions.length} rows deferred to next cycle`);

      // Pin the exact bytes only when they proved something moved.
      let bodyStorageId: string | undefined;
      if (diff.changes.length > 0) {
        bodyStorageId = await ctx.storage.store(new Blob([fetched.bytes as BlobPart], { type: "application/octet-stream" }));
      }

      const result = await ctx.runMutation(internal.ingest.write.commit, {
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
        observations: newVersions.map((o) => ({
          identityKey: o.identityKey,
          subject: o.subject,
          claimKind: o.claimKind,
          assertedAt: o.assertedAt,
          fields: o.fields,
          sigHash: o.sigHash,
          fullHash: o.fullHash,
        })),
        changes: diff.changes.filter((c) => c.kind === "removed" || kept.has(c.identityKey)).map((c) => ({
          identityKey: c.identityKey,
          subjectKey: c.subject.key,
          kind: c.kind,
          changed: c.changed,
          before: "before" in c ? c.before : undefined,
          after: "after" in c ? c.after : undefined,
          sentence: c.sentence,
        })),
        sourceUrl: adapter.datasetUrl,
        next,
      });
      console.log(
        `[${slug}] ${fetched.status} rows=${observations.length} new=${result.observations} changes=${result.changes}` +
          ` silent=${diff.silentUpdates} suppressed=${diff.suppressed} degraded=${diff.degraded} emit=${result.emitted}`,
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
  ctx: { runQuery: any },
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
    const res = await fetch(t.url, { headers });
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (res.status === 304) return { kind: "unchanged", url: t.url, etag: etag ?? source.lastEtag };
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(t.url).host}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const body: FetchBody =
      t.kind === "http_binary"
        ? { kind: "bytes", bytes, status: res.status, url: t.url, fetchedAt, etag, lastModified }
        : { kind: "text", text: new TextDecoder().decode(bytes), status: res.status, url: t.url, fetchedAt, etag, lastModified };
    return { kind: "body", url: t.url, status: res.status, etag, lastModified, bytes, bodySha256: await sha256Hex(bytes), body, rowCount: -1 };
  }

  throw new Error(`transport ${t.kind} not wired yet`);
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
