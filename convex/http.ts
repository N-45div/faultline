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

// Share pages. A link to an employer or a building pasted into a chat is
// unfurled by a crawler that runs no JavaScript, so the page's own words —
// the receipt headline and its first lines — go into the HTML head here,
// before the same app shell the static host serves everywhere else. The
// shell is fetched from the static host, so a new build needs no change.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const meta = (html: string, title: string, description: string, url: string) =>
  html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${esc(description)}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta\s+property="og:description"\s+content=")[^"]*(")/, `$1${esc(description)}$2`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${esc(url)}$2`)
    .replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, `$1${esc(description)}$2`);

const share = (kind: "e" | "b") =>
  httpAction(async (ctx, req) => {
    const u = new URL(req.url);
    const shell = await fetch(`${u.origin}/index.html`, { headers: { accept: "text/html" } });
    let html = await shell.text();
    try {
      const id = decodeURIComponent(u.pathname.split("/").filter(Boolean)[1] ?? "");
      if (id) {
        const r = kind === "e" ? await ctx.runQuery(api.lookup.employer, { q: id }) : await ctx.runQuery(api.lookup.building, { key: id });
        const receipt = r.receipt;
        const lead = receipt.blocks[0]?.slice(0, 3).join(" ") ?? "";
        const description = (lead || "Every version kept, dated, because the state overwrites its file.").slice(0, 280);
        const path = kind === "e" && "canonical" in r && r.canonical ? `/e/${r.canonical}` : u.pathname;
        html = meta(html, `${receipt.headline} · Notice`, description, `${u.origin}${path}`);
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
