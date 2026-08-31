import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// One cheap mutation a minute reads sources.by_due and schedules an action per
// due source. Each source carries its own cadence and jitter, so this is the
// only clock in the system.
crons.interval("tick sources", { minutes: 1 }, internal.ingest.write.tick, {});

// Ingest queues the news; this decides when it goes out. Looking every minute
// is what makes the first alert feel immediate; the one-a-day ceiling inside it
// is what stops a city file from becoming a hundred emails.
crons.interval("flush digests", { minutes: 1 }, internal.digest.flush, {});

export default crons;
