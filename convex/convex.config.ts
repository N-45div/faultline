import { defineApp } from "convex/server";
import { v } from "convex/values";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import agentmail from "@agentmail/convex/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";

const app = defineApp({
  env: {
    FIRECRAWL_API_KEY: v.string(),
    FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()),
  },
});

// The app owns the root so webhook URLs stay exact. Static routes are
// registered last in convex/http.ts and only catch what nothing else claimed.
app.use(staticHosting);

// Reads AGENTMAIL_API_KEY / AGENTMAIL_WEBHOOK_SECRET from deployment env.
app.use(agentmail);

// One-shot scrape/parse only. No httpPrefix means no component-mounted webhook,
// so the static catch-all stays the only wildcard route in the deployment.
app.use(firecrawl, {
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY,
    FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET,
  },
});

export default app;
