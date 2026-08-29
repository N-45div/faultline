import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { AgentMail } from "@agentmail/convex";

const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.inbound.onMessageReceived,
});

const http = httpRouter();

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

// Static site last: SPA fallback for everything nothing above claimed.
registerStaticRoutes(http, components.staticHosting);

export default http;
