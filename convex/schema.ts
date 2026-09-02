import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const fields = v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()));

export default defineSchema({
  // ---- sign-in (users, sessions, accounts, verification codes) --------------
  ...authTables,

  // ---- the engine -----------------------------------------------------------
  sources: defineTable({
    slug: v.string(),
    adapterVersion: v.number(),
    status: v.union(v.literal("active"), v.literal("paused")),
    /** Shadow mode: observe and diff, but write no change events yet. */
    emit: v.boolean(),
    nextRunAt: v.number(),
    lastRunAt: v.optional(v.number()),
    lastStatus: v.optional(v.string()),
    /** Rows in the last full read. A 304 keeps the previous count. */
    rowCount: v.optional(v.number()),
    lastBodySha256: v.optional(v.string()),
    lastEtag: v.optional(v.string()),
    cursor: v.optional(v.string()),
    lockedUntil: v.optional(v.number()),
    consecutiveFailures: v.number(),
    shadowCycles: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_due", ["status", "nextRunAt"]),

  subjects: defineTable({
    kind: v.union(v.literal("building"), v.literal("employer_site")),
    key: v.string(),
    label: v.string(),
  })
    .index("by_kind_key", ["kind", "key"])
    .searchIndex("search_label", { searchField: "label", filterFields: ["kind"] }),

  /** The only thing ingest reads: which subjects somebody is looking at. */
  targets: defineTable({
    sourceId: v.id("sources"),
    subjectKey: v.string(),
    active: v.boolean(),
    addedBy: v.union(v.literal("standing"), v.literal("case")),
  })
    .index("by_source_active", ["sourceId", "active"])
    .index("by_source_subject", ["sourceId", "subjectKey"]),

  /** One row per fetch. The body is pinned to storage only when something changed. */
  snapshots: defineTable({
    sourceId: v.id("sources"),
    capturedAt: v.number(),
    requestUrl: v.string(),
    httpStatus: v.number(),
    etag: v.optional(v.string()),
    lastModified: v.optional(v.string()),
    bodySha256: v.string(),
    bodyStorageId: v.optional(v.id("_storage")),
    rowCount: v.number(),
    degraded: v.boolean(),
    pinnedUntil: v.optional(v.number()),
  })
    .index("by_source_captured", ["sourceId", "capturedAt"])
    .index("by_bodyhash", ["bodySha256"])
    .index("by_gc", ["pinnedUntil"]),

  /** Every version of every watched row, dated when we froze it. */
  observations: defineTable({
    sourceId: v.id("sources"),
    snapshotId: v.id("snapshots"),
    identityKey: v.string(),
    subjectKey: v.string(),
    claimKind: v.string(),
    assertedAt: v.string(),
    capturedAt: v.number(),
    fields,
    sigHash: v.string(),
    fullHash: v.string(),
  })
    .index("by_source_identity", ["sourceId", "identityKey", "capturedAt"])
    .index("by_subject_claim", ["subjectKey", "claimKind", "assertedAt"]),

  /** Latest version per identity — the O(1) "before" for the diff. */
  current: defineTable({
    sourceId: v.id("sources"),
    identityKey: v.string(),
    subjectKey: v.string(),
    observationId: v.id("observations"),
    sigHash: v.string(),
    fullHash: v.string(),
    fields,
    updatedAt: v.number(),
    /** For flap suppression: the sigHash before this one, and when. */
    prevSigHash: v.optional(v.string()),
    prevUpdatedAt: v.optional(v.number()),
  })
    .index("by_source_identity", ["sourceId", "identityKey"])
    .index("by_source_subject", ["sourceId", "subjectKey"]),

  changes: defineTable({
    sourceId: v.id("sources"),
    subjectKey: v.string(),
    identityKey: v.string(),
    kind: v.union(v.literal("added"), v.literal("changed"), v.literal("removed")),
    detectedAt: v.number(),
    /** ≤16 paths, so the UI renders before/after with zero blob reads. */
    changed: v.array(v.string()),
    before: v.optional(fields),
    after: v.optional(fields),
    sentence: v.string(),
    emit: v.boolean(),
    snapshotId: v.id("snapshots"),
  })
    .index("by_source_emit", ["sourceId", "emit", "detectedAt"])
    .index("by_subject", ["subjectKey", "detectedAt"]),

  /** The public wall. Capped at 50 per source; the oldest is deleted in the same mutation. */
  recentChanges: defineTable({
    sourceId: v.id("sources"),
    /** The first change this line stands for; a grouped line stands for `count`. */
    changeId: v.id("changes"),
    createdAt: v.number(),
    sentence: v.string(),
    sourceUrl: v.string(),
    subjectKey: v.optional(v.string()),
    count: v.optional(v.number()),
    /** 3: a filing or the city's stamp. 2: a status that moved. 1: routine. */
    weight: v.optional(v.number()),
  }).index("by_source", ["sourceId", "createdAt"]),

  pulseBuckets: defineTable({
    sourceId: v.id("sources"),
    minute: v.number(),
    count: v.number(),
  })
    .index("by_source_minute", ["sourceId", "minute"])
    .index("by_minute", ["minute"]),

  // ---- the inbox -----------------------------------------------------------
  /** Every email that reached the address. Idempotent on messageId; webhooks retry. */
  inbox: defineTable({
    messageId: v.string(),
    threadId: v.string(),
    inboxId: v.string(),
    fromAddress: v.string(),
    subject: v.string(),
    receivedAt: v.number(),
    authenticated: v.boolean(),
    intent: v.string(),
    query: v.string(),
    matchedSubjectKey: v.optional(v.string()),
    bodyHash: v.string(),
    replied: v.boolean(),
  })
    .index("by_message_id", ["messageId"])
    .index("by_thread", ["threadId"])
    .index("by_from", ["fromAddress", "receivedAt"]),

  /** What we sent back. */
  receipts: defineTable({
    inboxId: v.optional(v.id("inbox")),
    threadId: v.optional(v.string()),
    query: v.string(),
    kind: v.union(v.literal("layoff"), v.literal("building"), v.literal("none")),
    subjectKey: v.optional(v.string()),
    text: v.string(),
    html: v.string(),
    createdAt: v.number(),
    outboundId: v.optional(v.string()),
  })
    .index("by_subject", ["subjectKey", "createdAt"])
    .index("by_thread", ["threadId"])
    .index("by_created", ["createdAt"]),

  /** "Reply FOLLOW": email me when this filing changes. */
  subscriptions: defineTable({
    subjectKey: v.string(),
    email: v.string(),
    threadId: v.optional(v.string()),
    /** The FOLLOW message, so a change is answered in the same thread. */
    messageId: v.optional(v.string()),
    createdAt: v.number(),
    active: v.boolean(),
    /** The one-a-day ceiling is per person, so it is stamped on every follow. */
    lastEmailedAt: v.optional(v.number()),
  })
    .index("by_subject", ["subjectKey", "active"])
    .index("by_email", ["email", "subjectKey"]),

  /**
   * News waiting to be sent. Ingest queues; the digest cron sends. A city file
   * can move hundreds of rows in one cycle and that must never become hundreds
   * of emails, so nobody hears from us more than once a day.
   */
  alertQueue: defineTable({
    email: v.string(),
    subjectKey: v.string(),
    sentence: v.string(),
    sourceUrl: v.string(),
    status: v.union(v.literal("pending"), v.literal("sent")),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_status_created", ["status", "createdAt"])
    .index("by_email_status", ["email", "status"]),

  // ---- the product ---------------------------------------------------------
  cases: defineTable({
    slug: v.string(),
    kind: v.union(v.literal("layoff"), v.literal("housing"), v.literal("unknown")),
    title: v.string(),
    subjectKey: v.optional(v.string()),
    jurisdiction: v.optional(v.string()),
    isPublic: v.boolean(),
    publicToken: v.optional(v.string()),
    ownerMemberKeyHash: v.string(),
    inboxAddress: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_public_token", ["publicToken"])
    .index("by_subject", ["subjectKey"]),

  caseTargets: defineTable({
    caseId: v.id("cases"),
    targetId: v.id("targets"),
  })
    .index("by_case", ["caseId"])
    .index("by_target", ["targetId"]),

  members: defineTable({
    caseId: v.id("cases"),
    emailNormalized: v.optional(v.string()),
    name: v.string(),
    memberKeyHash: v.string(),
    role: v.union(v.literal("owner"), v.literal("member")),
    createdAt: v.number(),
  })
    .index("by_case_email", ["caseId", "emailNormalized"])
    .index("by_member_key", ["memberKeyHash"]),

  /**
   * THE live board query, always prefixed by caseId. A global by_created index
   * is forbidden: every insert would re-run every subscriber.
   */
  feedItems: defineTable({
    caseId: v.id("cases"),
    kind: v.string(),
    createdAt: v.number(),
    sentence: v.string(),
    refTable: v.optional(v.string()),
    refId: v.optional(v.string()),
    payload: v.optional(v.any()),
  })
    .index("by_case_created", ["caseId", "createdAt"])
    .index("by_case_kind_created", ["caseId", "kind", "createdAt"]),

  forwardedEmails: defineTable({
    caseId: v.id("cases"),
    messageId: v.string(),
    threadId: v.string(),
    fromAddress: v.string(),
    subject: v.string(),
    receivedAt: v.number(),
    authenticated: v.boolean(),
    bodySha256: v.string(),
    /** Redacted at ingest: emails, phones, SSNs, unit numbers. */
    redactedText: v.string(),
  })
    .index("by_message_id", ["messageId"])
    .index("by_case_received", ["caseId", "receivedAt"])
    .index("by_thread", ["threadId"]),

  claims: defineTable({
    caseId: v.id("cases"),
    forwardedEmailId: v.id("forwardedEmails"),
    subjectKey: v.optional(v.string()),
    claimKind: v.string(),
    assertedAt: v.string(),
    fields,
    quote: v.string(),
    confidence: v.number(),
    /** SPF/DKIM-failed mail is stored and never becomes evidence. */
    authenticated: v.boolean(),
  })
    .index("by_case_subject_kind", ["caseId", "subjectKey", "claimKind"])
    .index("by_subject_kind", ["subjectKey", "claimKind"]),

  findings: defineTable({
    caseId: v.id("cases"),
    claimId: v.optional(v.id("claims")),
    ruleId: v.string(),
    detectedAt: v.number(),
    result: v.any(),
    sentence: v.string(),
  })
    .index("by_case_detected", ["caseId", "detectedAt"])
    .index("by_claim", ["claimId"]),

  /** One model call per unique body. Re-forwarding the same letter costs nothing. */
  extractions: defineTable({
    bodySha256: v.string(),
    model: v.string(),
    output: v.any(),
    createdAt: v.number(),
    promptVersion: v.optional(v.string()),
    costCents: v.optional(v.number()),
  }).index("by_body_sha", ["bodySha256"]),

  /**
   * What the employer said in public, beside what they filed. One row per
   * employer and filing date — the search is the expensive part, so it is
   * bought once and kept.
   */
  corroborations: defineTable({
    employer: v.string(),
    filingDate: v.string(),
    subjectKey: v.optional(v.string()),
    corroborated: v.boolean(),
    statementDate: v.union(v.string(), v.null()),
    employerStatement: v.union(v.string(), v.null()),
    speakerOrOutlet: v.union(v.string(), v.null()),
    confidence: v.string(),
    /** Shown as links, always: OpenAI requires visible, clickable citations. */
    citations: v.array(v.object({ url: v.string(), title: v.string() })),
    costCents: v.number(),
    createdAt: v.number(),
  }).index("by_key", ["employer", "filingDate"]),

  /** Every model call, priced in cents at the moment it was made. */
  llmUsage: defineTable({
    model: v.string(),
    purpose: v.string(),
    inputTokens: v.number(),
    cachedTokens: v.number(),
    outputTokens: v.number(),
    costCents: v.number(),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),

  /** One requested evidence pack: a PDF built from the versions we hold. */
  packs: defineTable({
    subjectKey: v.string(),
    query: v.string(),
    kind: v.union(v.literal("layoff"), v.literal("building")),
    requestedBy: v.string(),
    /** Where the finished PDF is delivered: the requester's own thread. */
    agentInboxId: v.optional(v.string()),
    messageId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    downloadToken: v.string(),
    storageId: v.optional(v.id("_storage")),
    /** "expired": the PDF was removed after thirty days; the receipt it was built from is kept. */
    status: v.union(v.literal("building"), v.literal("ready"), v.literal("failed"), v.literal("expired")),
    pages: v.optional(v.number()),
    bytes: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_download_token", ["downloadToken"])
    .index("by_subject", ["subjectKey", "createdAt"]),

  /** One row per provider: failures in a row, and until when the breaker is open. */
  breakers: defineTable({
    provider: v.string(),
    failures: v.number(),
    openedUntil: v.number(),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_provider", ["provider"]),
});
