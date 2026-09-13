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

// Evidence packs are built from what we hold and can be built again; the PDF
// itself goes after thirty days so storage holds versions, not copies.
crons.daily("expire packs", { hourUTC: 4, minuteUTC: 20 }, internal.packs.expire, {});

// The scorecard: every state's file against its statute, once a day.
crons.daily("refresh scorecard", { hourUTC: 5, minuteUTC: 10 }, internal.wall.refreshScorecard, {});

// The landing page's numbers, counted once an hour rather than once a view.
crons.hourly("refresh stats", { minuteUTC: 7 }, internal.wall.refreshStats, {});

// The city's own thirty-day count of certifications and false ones, once a day.
crons.daily("refresh housing pulse", { hourUTC: 6, minuteUTC: 15 }, internal.wall.refreshHousingPulse, {});

// Sent alerts older than a week.
crons.daily("gc sent alerts", { hourUTC: 4, minuteUTC: 40 }, internal.digest.gc, {});

export default crons;
