import { AgentMail } from "@agentmail/convex";
import { components, internal } from "./_generated/api";

// One AgentMail client for the deployment. The component verifies AgentMail's
// webhook, stores each event once, and hands us inbound mail and the delivery
// events for mail we sent. It does not send for us: a component runs with its
// own environment and cannot read the deployment's AGENTMAIL_API_KEY.
export const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.inbound.onMessageReceived,
  onEvent: internal.inbound.onMailEvent,
});
