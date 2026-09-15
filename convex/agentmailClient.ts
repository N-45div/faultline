import { AgentMail } from "@agentmail/convex";
import { components, internal } from "./_generated/api";

// One AgentMail client for the whole deployment. The webhook route hands it
// inbound mail; the reply path hands it every reply to a person, which the
// component queues in its own table, sends through a workpool with retries,
// and moves from pending to sent to delivered as AgentMail's events arrive.
// It reads AGENTMAIL_API_KEY and AGENTMAIL_WEBHOOK_SECRET from the deployment.
export const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.inbound.onMessageReceived,
  retryAttempts: 5,
  initialBackoffMs: 2_000,
});
