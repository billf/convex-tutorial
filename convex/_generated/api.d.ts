/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chat from "../chat.js";
import type * as proofVehicle_feed from "../proofVehicle/feed.js";
import type * as proofVehicle_fixture from "../proofVehicle/fixture.js";
import type * as proofVehicle_mutations from "../proofVehicle/mutations.js";
import type * as proofVehicle_tables from "../proofVehicle/tables.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chat: typeof chat;
  "proofVehicle/feed": typeof proofVehicle_feed;
  "proofVehicle/fixture": typeof proofVehicle_fixture;
  "proofVehicle/mutations": typeof proofVehicle_mutations;
  "proofVehicle/tables": typeof proofVehicle_tables;
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

export declare const components: {};
