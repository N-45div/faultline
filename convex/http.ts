import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, components, internal } from "./_generated/api";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { AgentMail } from "@agentmail/convex";
import { auth } from "./auth";

const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.inbound.onMessageReceived,
});

const http = httpRouter();

// Sign-in routes (/.well-known/*, /api/auth/*) must sit above the static
// catch-all for the same reason the webhook does.
auth.addHttpRoutes(http);

// Exact routes first. A webhook registered below the static catch-all is
// unreachable, and one that 200s with index.html looks exactly like
// "the vendor isn't delivering".
http.route({
  path: "/hooks/agentmail",
  method: "POST",
  // @agentmail/convex 0.1.0 types ctx against an older convex-helpers
  // RunMutationCtx; convex 1.45 added an options parameter. Runtime-identical.
  handler: httpAction(async (ctx, req) => agentmail.handleWebhook(ctx as any, req)),
});

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => new Response("ok", { status: 200 })),
});

// Evidence pack downloads. The token is the whole authorisation: 40 hex chars,
// one pack, delivered only to the thread that asked for it.
http.route({
  pathPrefix: "/pack/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
    const pack = await ctx.runQuery(internal.packs.byToken, { token });
    if (!pack || pack.status !== "ready" || !pack.storageId) return new Response("Not found", { status: 404 });
    const blob = await ctx.storage.get(pack.storageId);
    if (!blob) return new Response("Not found", { status: 404 });
    const name = `notice-pack-${pack.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "evidence"}.pdf`;
    return new Response(blob, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }),
});

// The file as the state served it on the day of a commit: the exact bytes we
// hashed, with the hash in the headers. A commit page links here; the bytes
// are held for 14 days after a read that changed something, then released.
http.route({
  pathPrefix: "/raw/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
    const raw = await ctx.runQuery(internal.files.rawBody, { id });
    if (!raw) return new Response("Not held. The bytes of a read are kept for 14 days after a commit that changed something.", { status: 404 });
    const blob = await ctx.storage.get(raw.storageId);
    if (!blob) return new Response("Not held.", { status: 404 });
    const ext = /\.(xlsx|xls|csv|json|html?|pdf)(?:$|\?)/i.exec(raw.requestUrl)?.[1]?.toLowerCase() ?? "bin";
    const name = `${raw.slug}-${new Date(raw.capturedAt).toISOString().slice(0, 10)}-${raw.sha256.slice(0, 12)}.${ext}`;
    return new Response(blob, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Faultline-SHA256": raw.sha256,
        "X-Faultline-Captured-At": new Date(raw.capturedAt).toISOString(),
        "Cache-Control": "public, max-age=86400",
      },
    });
  }),
});

// The lawyer's export on the web: the same rows the employer page shows, one
// filing per line. Public record data, no spend, no account — the receipt
// already shows every value here; this is the same thing as a file.
http.route({
  pathPrefix: "/csv/e/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const u = new URL(req.url);
    let slug = "";
    try {
      slug = decodeURIComponent(u.pathname.split("/").filter(Boolean)[2] ?? "").replace(/\.csv$/i, "");
    } catch {
      slug = "";
    }
    if (!slug) return new Response("Not found", { status: 404 });
    const out = await ctx.runQuery(api.lookup.exportCsv, { q: slug });
    if (!out) return new Response("Not found", { status: 404 });
    return new Response(out.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "Cache-Control": "public, max-age=300",
      },
    });
  }),
});

// Share pages. A link to an employer or a building pasted into a chat is
// unfurled by a crawler that runs no JavaScript, so the page's own words —
// the receipt headline and its first lines — go into the HTML head here,
// before the same app shell the static host serves everywhere else. The
// shell is fetched from the static host, so a new build needs no change.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Every replacement goes through a function. A string replacement treats $&,
// $1 and $' as instructions, and the text here is a receipt that echoes what
// somebody typed — "/e/$&" was enough to break out of the attribute and
// duplicate markup into the head.
const meta = (html: string, title: string, description: string, url: string) =>
  html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, (_m, a, b) => `${a}${esc(description)}${b}`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, (_m, a, b) => `${a}${esc(title)}${b}`)
    .replace(/(<meta\s+property="og:description"\s+content=")[^"]*(")/, (_m, a, b) => `${a}${esc(description)}${b}`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, (_m, a, b) => `${a}${esc(url)}${b}`)
    .replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, (_m, a, b) => `${a}${esc(title)}${b}`)
    .replace(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, (_m, a, b) => `${a}${esc(description)}${b}`);

const share = (kind: "e" | "b") =>
  httpAction(async (ctx, req) => {
    const u = new URL(req.url);
    // The shell fetch is inside the try, with a timeout: an employer page that
    // 500s because the static host hiccuped is worse than one without its
    // social preview, and this route serves every /e/ and /b/ page load.
    let html = "";
    try {
      const shell = await fetch(`${u.origin}/index.html`, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(4000) });
      if (!shell.ok) throw new Error(`shell ${shell.status}`);
      html = await shell.text();
    } catch (e) {
      console.error(`[share] shell fetch failed: ${(e as Error).message}`);
      return Response.redirect(`${u.origin}/index.html`, 302);
    }
    try {
      const id = decodeURIComponent(u.pathname.split("/").filter(Boolean)[1] ?? "");
      if (id) {
        const r = kind === "e" ? await ctx.runQuery(api.lookup.employer, { q: id }) : await ctx.runQuery(api.lookup.building, { key: id });
        const receipt = r.receipt;
        const lead = receipt.blocks[0]?.slice(0, 3).join(" ") ?? "";
        const description = (lead || "Every version kept, dated, because the state overwrites its file.").slice(0, 280);
        const path = kind === "e" && "canonical" in r && r.canonical ? `/e/${r.canonical}` : u.pathname;
        html = meta(html, `${receipt.headline} · Faultline`, description, `${u.origin}${path}`);
      }
    } catch (e) {
      console.warn(`[share] ${u.pathname}: ${(e as Error).message}`);
    }
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  });
http.route({ pathPrefix: "/e/", method: "GET", handler: share("e") });
http.route({ pathPrefix: "/b/", method: "GET", handler: share("b") });

// Static site last: SPA fallback for everything nothing above claimed.
registerStaticRoutes(http, components.staticHosting);

export default http;
