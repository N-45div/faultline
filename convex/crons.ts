import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// One cheap mutation a minute reads sources.by_due and schedules an action per
// due source. Each source carries its own cadence and jitter, so this is the
// only clock in the system.
crons.interval("tick sources", { minutes: 1 }, internal.ingest.write.tick, {});

export default crons;
