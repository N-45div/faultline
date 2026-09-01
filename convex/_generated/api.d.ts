/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as corroborate from "../corroborate.js";
import type * as corroborateData from "../corroborateData.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as digest from "../digest.js";
import type * as follows from "../follows.js";
import type * as http from "../http.js";
import type * as inbound from "../inbound.js";
import type * as ingest_fetch from "../ingest/fetch.js";
import type * as ingest_seed from "../ingest/seed.js";
import type * as ingest_write from "../ingest/write.js";
import type * as llm from "../llm.js";
import type * as llmActions from "../llmActions.js";
import type * as lookup from "../lookup.js";
import type * as mail from "../mail.js";
import type * as packBuild from "../packBuild.js";
import type * as packs from "../packs.js";
import type * as sources from "../sources.js";
import type * as wall from "../wall.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  corroborate: typeof corroborate;
  corroborateData: typeof corroborateData;
  crons: typeof crons;
  debug: typeof debug;
  digest: typeof digest;
  follows: typeof follows;
  http: typeof http;
  inbound: typeof inbound;
  "ingest/fetch": typeof ingest_fetch;
  "ingest/seed": typeof ingest_seed;
  "ingest/write": typeof ingest_write;
  llm: typeof llm;
  llmActions: typeof llmActions;
  lookup: typeof lookup;
  mail: typeof mail;
  packBuild: typeof packBuild;
  packs: typeof packs;
  sources: typeof sources;
  wall: typeof wall;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
};
