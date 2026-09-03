"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { OWN_ACT, statuteName, warnNoticeGap, WARN_EXCEPTIONS, WARN_STATUTORY_DAYS } from "../engine/rules";
import { complianceLines } from "../engine/receipt";

// Builds the evidence pack: one PDF holding the filing as it stands, every
// dated version we hold with its hash, the changes we recorded, the statute,
// and how the capture works. This is the thing a person hands a lawyer, so it
// uses the record's own words and never a verdict.

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 54;
const INK = rgb(0.106, 0.106, 0.106);
const MUTED = rgb(0.42, 0.4, 0.37);
const ACCENT = rgb(0.7, 0.15, 0.12);

/** pdf-lib's standard fonts are WinAnsi: map typography down, drop the rest. */
function clean(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[•·]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

class Pdf {
  doc!: PDFDocument;
  font!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;

  static async create(): Promise<Pdf> {
    const p = new Pdf();
    p.doc = await PDFDocument.create();
    p.font = await p.doc.embedFont(StandardFonts.Helvetica);
    p.bold = await p.doc.embedFont(StandardFonts.HelveticaBold);
    p.newPage();
    return p;
  }

  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.y = A4.h - MARGIN;
  }

  space(pt: number) {
    this.y -= pt;
    if (this.y < MARGIN) this.newPage();
  }

  text(raw: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.font;
    const color = opts.color ?? INK;
    const indent = opts.indent ?? 0;
    const width = A4.w - 2 * MARGIN - indent;
    const words = clean(raw).split(" ");
    let line = "";
    const flush = () => {
      if (!line) return;
      if (this.y < MARGIN + size) this.newPage();
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font, color });
      this.y -= size * 1.45;
      line = "";
    };
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) > width && line) flush();
      line = line ? `${line} ${w}` : w;
    }
    flush();
  }

  heading(t: string) {
    this.space(16);
    this.text(t.toUpperCase(), { size: 9, bold: true, color: MUTED });
    this.space(4);
  }
}

interface PackData {
  pack: { token: string; query: string; kind: "layoff" | "building"; agentInboxId?: string; messageId?: string; createdAt: number };
  subjectLabel: string;
  currents: { sourceSlug: string; fields: Record<string, string | number | boolean | null>; identityKey: string }[];
  observations: { identityKey: string; assertedAt: string; capturedAt: number; fullHash: string; fields: Record<string, string | number | boolean | null> }[];
  changes: { detectedAt: number; sentence: string }[];
  firstCapture: string;
}

const STATE: Record<string, string> = {
  "ny-warn": "New York",
  "ca-warn": "California",
  "va-warn": "Virginia",
  "nj-warn": "New Jersey",
  "md-warn": "Maryland",
  "nc-warn": "North Carolina",
  "co-warn": "Colorado",
};
const JURIS: Record<string, string> = {
  "ny-warn": "US-NY",
  "ca-warn": "US-CA",
  "va-warn": "US-VA",
  "nj-warn": "US-NJ",
  "md-warn": "US-MD",
  "nc-warn": "US-NC",
  "co-warn": "US-CO",
};
/** States with a WARN act of their own; the rest are federal 60 days only. */
// Imported, not redeclared: section 1 and section 4 of this PDF once disagreed
// about whether Virginia has a WARN act, inside one document.


const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** The date the state published it. New York and California name it differently. */
function statePostedDate(f: Record<string, string | number | boolean | null>): string | undefined {
  const v = f.postedDate ?? f.processedDate;
  return v ? String(v) : undefined;
}

function fieldLines(fields: Record<string, string | number | boolean | null>): string[] {
  return Object.entries(fields)
    .filter(([k, val]) => !k.startsWith("__") && val !== null && val !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, val]) => `${k}: ${String(val)}`);
}

function renderPack(pdf: Pdf, d: PackData) {
  const generated = iso(Date.now());

  // Cover.
  pdf.space(40);
  pdf.text("NOTICE", { size: 30, bold: true });
  pdf.space(2);
  pdf.text("Evidence pack", { size: 16, color: MUTED });
  pdf.space(24);
  pdf.text(d.subjectLabel, { size: 18, bold: true });
  pdf.space(10);
  pdf.text(`Generated ${generated}. Records held since ${d.firstCapture}.`, { color: MUTED });
  pdf.text(`Pack reference: ${d.pack.token.slice(0, 12)}`, { color: MUTED });
  pdf.space(20);
  pdf.text(
    "What this is: the public record as the government published it, kept as dated versions. Each version below carries the time we captured it and a cryptographic hash of its content. The agencies overwrite these files; we keep what was there before.",
  );
  pdf.space(8);
  pdf.text(
    "What this is not: a legal conclusion. Nothing here says anything was unlawful. Employers can claim exceptions, and agencies correct records. This pack shows dates, the record's own words, and one statute - the questions belong to a lawyer; this is the dated proof you bring them.",
  );

  // Section 1: the filing as it stands.
  pdf.heading("1. The record as it stands today");
  if (d.currents.length === 0) pdf.text("No rows currently held for this subject.", { color: MUTED });
  for (const c of d.currents.slice(0, 15)) {
    pdf.space(8);
    if (d.pack.kind === "layoff") {
      const f = c.fields;
      const state = STATE[c.sourceSlug as keyof typeof STATE] ?? c.sourceSlug;
      pdf.text(`${String(f.company ?? d.subjectLabel)} - ${String(f.siteAddress ?? "")} (${state})`, { bold: true, size: 11.5 });
      for (const line of fieldLines(f)) pdf.text(line, { indent: 12, size: 9.5 });
      if (f.noticeDate && f.effectiveDate) {
        const g = warnNoticeGap({
          jurisdiction: JURIS[c.sourceSlug as keyof typeof JURIS] ?? "US",
          noticeDate: String(f.noticeDate),
          effectiveDate: String(f.effectiveDate),
          // New York calls it postedDate, California calls it processedDate.
          // Reading only one silently drops the state's lag on the other.
          postedDate: statePostedDate(f),
        });
        pdf.space(3);
        pdf.text(
          `${g.actualDays} days between the notice date and the start of the layoff. ${statuteName(JURIS[c.sourceSlug as keyof typeof JURIS] ?? "US")} sets ${g.statutoryDays} days.`,
          { indent: 12, size: 10, bold: true, color: g.verdict === "gap" ? ACCENT : INK },
        );
        if (g.postingLagDays !== null)
          pdf.text(
            `The state put this online ${g.postingLagDays} days after the notice date${g.postedAfterEffective ? " - after the layoff had started. That lag is the state's, not the employer's." : "."}`,
            { indent: 12, size: 9.5, color: MUTED },
          );
      } else if (f.noticeMonth) {
        // New Jersey publishes the month it posted a notice and never the day,
        // so this pack states the rule and leaves the count out rather than
        // putting a number in a lawyer's hands that the file cannot support.
        const days = WARN_STATUTORY_DAYS[JURIS[c.sourceSlug as keyof typeof JURIS] ?? "US"] ?? WARN_STATUTORY_DAYS["US"];
        pdf.space(3);
        pdf.text(
          `${state} publishes the month it posted this notice (${String(f.noticeMonth)}) and not the date the employer gave, so the notice period cannot be counted from the state's file. ${OWN_ACT[JURIS[c.sourceSlug as keyof typeof JURIS] ?? ""] ?? "The federal rule"} sets ${days} days.`,
          { indent: 12, size: 10, bold: true, color: INK },
        );
      }
    } else {
      const f = c.fields;
      pdf.text(`Violation ${String(f.violationid ?? c.identityKey)} - class ${String(f.class ?? "?")}`, { bold: true, size: 11.5 });
      for (const line of fieldLines(f)) pdf.text(line, { indent: 12, size: 9.5 });
    }
  }
  if (d.currents.length > 15) pdf.text(`...and ${d.currents.length - 15} more rows, all in the version history below.`, { color: MUTED });

  // Section 2: every version.
  pdf.heading("2. Every version we hold");
  pdf.text(
    "One block per row of the government file, oldest first. A version is recorded when the row's content changes; the hash is SHA-256 over the row's normalised fields, computed at capture.",
    { color: MUTED, size: 9.5 },
  );
  const byIdentity = new Map<string, PackData["observations"]>();
  for (const o of d.observations) byIdentity.set(o.identityKey, [...(byIdentity.get(o.identityKey) ?? []), o]);
  for (const [identity, versions] of byIdentity) {
    versions.sort((a, b) => a.capturedAt - b.capturedAt);
    pdf.space(8);
    pdf.text(identity, { bold: true, size: 10 });
    let prev: Record<string, string | number | boolean | null> | null = null;
    for (const o of versions) {
      const changed = prev
        ? Object.keys({ ...prev, ...o.fields }).filter((k) => !k.startsWith("__") && String(prev![k] ?? "") !== String(o.fields[k] ?? ""))
        : [];
      const suffix = prev ? (changed.length ? ` - changed: ${changed.join(", ")}` : " - unchanged content, re-verified") : " - first capture";
      pdf.text(`captured ${iso(o.capturedAt)} - hash ${o.fullHash.slice(0, 16)}${suffix}`, { indent: 12, size: 9 });
      prev = o.fields;
    }
  }

  // Section 3: recorded changes.
  if (d.changes.length > 0) {
    pdf.heading("3. Changes we recorded");
    for (const c of [...d.changes].sort((a, b) => a.detectedAt - b.detectedAt)) {
      pdf.text(`${iso(c.detectedAt)} - ${c.sentence}`, { size: 9.5 });
      pdf.space(2);
    }
  }

  // Section 4: the statute.
  pdf.heading(`${d.changes.length > 0 ? 4 : 3}. The statute`);
  if (d.pack.kind === "layoff") {
    // One paragraph per state this employer actually filed in — never a
    // paragraph about a state they did not.
    const present = [...new Set(d.currents.map((c) => JURIS[c.sourceSlug]).filter(Boolean))];
    pdf.text(`Federal WARN requires ${WARN_STATUTORY_DAYS["US"]} days' written notice.`);
    for (const j of present) {
      const name = Object.entries(JURIS).find(([, v]) => v === j)?.[0];
      const stateName = name ? STATE[name] : j;
      const days = WARN_STATUTORY_DAYS[j] ?? WARN_STATUTORY_DAYS["US"];
      pdf.space(3);
      pdf.text(
        OWN_ACT[j]
          ? `${OWN_ACT[j]} sets ${days} days.`
          : `${stateName} has no WARN act of its own; the federal ${days} days is the whole rule.`,
      );
      pdf.text(`Exceptions an employer may claim in ${stateName}: ${(WARN_EXCEPTIONS[j] ?? WARN_EXCEPTIONS["US"]).join("; ")}.`, { size: 9.5, color: MUTED });
    }
    pdf.space(4);
    pdf.text(
      "Two dates appear throughout and they are kept apart: the notice date is the employer's; the posting date is the state's. A posting lag says nothing about the employer.",
      { size: 9.5, color: MUTED },
    );
  } else {
    pdf.text(
      "New York City's Housing Maintenance Code classifies violations: class A is non-hazardous, class B hazardous, class C immediately hazardous - the city's own scale. FALSE CERTIFICATION and INVALID CERTIFICATION are the city's own stamps, applied when an owner's certification of correction did not stand.",
    );
  }

  // Section 5: method.
  pdf.heading("How this was captured");
  pdf.text(
    "The government file is fetched on a schedule and parsed deterministically. Each row is identified by its stable key, normalised, and hashed; a new version is stored only when the content differs. The raw bytes of each fetch that changed anything are also retained. No text in this pack was written or altered by a model.",
    { size: 9.5, color: MUTED },
  );
  pdf.space(4);
  pdf.text(`Notice - the address that writes back. Questions and updates: ${process.env.AGENTMAIL_INBOX_ID ?? "getnotice@agentmail.to"}`, {
    size: 9.5,
    color: MUTED,
  });
}

export const buildPack = internalAction({
  args: { packId: v.id("packs"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { packId, attempt }) => {
    const tries = attempt ?? 1;
    const d = (await ctx.runQuery(internal.packs.data, { packId })) as PackData | null;
    const inbox = process.env.AGENTMAIL_INBOX_ID ?? "";
    try {
      if (!d) throw new Error("pack not found");
      const pdf = await Pdf.create();
      renderPack(pdf, d);
      const bytes = await pdf.doc.save();
      const pages = pdf.doc.getPageCount();
      const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
      await ctx.runMutation(internal.packs.ready, { packId, storageId, pages, bytes: bytes.byteLength });

      const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
      const url = `${site}/pack/${d.pack.token}`;
      const nl = String.fromCharCode(10);
      const text = [
        `Your evidence pack for ${d.pack.query} is ready - ${pages} pages, attached to this email.`,
        "",
        `It is also here: ${url}`,
        "",
        "Inside: the record as it stands, every dated version we hold with its hash, the changes we recorded, the statute, and how the capture works.",
        "",
        "The pack is free.",
        // The pack email is mail too: it carries the same compliance lines as
        // everything else we send, not a price.
        ...complianceLines(process.env.NOTICE_POSTAL, "you are getting this because you asked us for this pack"),
      ].join(nl);
      if (d.pack.agentInboxId && d.pack.messageId && bytes.byteLength < 3_000_000) {
        await ctx.scheduler.runAfter(0, internal.mail.reply, {
          agentInboxId: d.pack.agentInboxId,
          parentMessageId: d.pack.messageId,
          text,
          attachments: [
            {
              filename: `notice-pack-${d.pack.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.pdf`,
              content: Buffer.from(bytes).toString("base64"),
              contentType: "application/pdf",
            },
          ],
        });
      }
      console.log(`[pack] built ${pages} pages, ${bytes.byteLength} bytes for "${d.pack.query}"`);
    } catch (e) {
      console.error(`[pack] failed (attempt ${tries}): ${String(e)}`);
      // "We're on it" has to be true, so one retry actually happens before we
      // say anything to the person who asked.
      if (tries < 2) {
        await ctx.scheduler.runAfter(60_000, internal.packBuild.buildPack, { packId, attempt: tries + 1 });
        return null;
      }
      await ctx.runMutation(internal.packs.failed, { packId });
      if (d?.pack.agentInboxId && d.pack.messageId && inbox) {
        await ctx.scheduler.runAfter(0, internal.mail.reply, {
          agentInboxId: d.pack.agentInboxId,
          parentMessageId: d.pack.messageId,
          text: "We tried twice and couldn't build your evidence pack. Reply PACK and the name again and we'll have another go - or just reply here and a person will read it.",
        });
      }
    }
    return null;
  },
});
