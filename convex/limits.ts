import { DAY, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

// The ceilings, in one place. Each is a fixed window: a day's worth of room
// that refills at the same moment for everyone, which is what a person expects
// from "we answer you twenty times a day" — not a drip.
//
// These were counts over the inbox, receipts, pages and usage tables. The
// component holds one counter per limit instead, so a busy day costs the same
// reads as a quiet one, and two messages arriving together cannot both pass a
// limit with one place left.
/** Agent runs a day, counted apart from letters so neither can starve the other. */
export const AGENT_DAILY_CAP = 40;

export const limits = new RateLimiter(components.rateLimiter, {
  /** Replies to one address. A person with a real question never reaches it. */
  replyToSender: { kind: "fixed window", rate: 20, period: DAY },
  /** The inbox's own reputation: everything we send, to everyone. */
  replyAll: { kind: "fixed window", rate: 150, period: DAY },
  /** Pages kept on request, per person and for the deployment. */
  pageForSender: { kind: "fixed window", rate: 5, period: DAY },
  pageAll: { kind: "fixed window", rate: 25, period: DAY },
  /** Runs of the inbox agent, which cost money. */
  agentRun: { kind: "fixed window", rate: AGENT_DAILY_CAP, period: DAY },
});
