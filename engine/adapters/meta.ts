// Adapter identity without the parsers, so V8-runtime mutations can bootstrap
// sources without pulling xlsx into their bundle.
export const ADAPTERS = [
  { id: "nyc-hpd", version: 1, targeting: "server_filter" },
  { id: "ny-warn", version: 1, targeting: "whole_file" },
  { id: "ca-warn", version: 1, targeting: "whole_file" },
  { id: "md-warn", version: 1, targeting: "whole_file" },
  { id: "co-warn", version: 1, targeting: "whole_file" },
  { id: "nc-warn", version: 1, targeting: "whole_file" },
  { id: "va-warn", version: 1, targeting: "whole_file" },
] as const;

export type AdapterId = (typeof ADAPTERS)[number]["id"];
