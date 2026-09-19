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
  // The browser trial needs no mailbox, so anyone can open one, and a script
  // can open a thousand. It gets rooms of its own: nothing done in a browser
  // can spend the inbox's replies, its pages, or its agent runs.
  webSender: { kind: "fixed window", rate: 25, period: DAY },
  webAll: { kind: "fixed window", rate: 150, period: DAY },
  /** Asking about a building reads every row we hold for it. */
  webAsk: { kind: "fixed window", rate: 40, period: DAY },
  webAgentRun: { kind: "fixed window", rate: 40, period: DAY },
  webPage: { kind: "fixed window", rate: 6, period: DAY },
  /** Runs of the inbox agent, which cost money. */
  agentRun: { kind: "fixed window", rate: AGENT_DAILY_CAP, period: DAY },
});
