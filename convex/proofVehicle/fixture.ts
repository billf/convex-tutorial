/**
 * Harness fixture: the marker sequence, the guarded reset, and the
 * convex-test-side base loader. The loading plan itself (phase order,
 * message ordering, natural keys) lives in `./basePlan`, shared with the
 * deployment loader CLI; parity hashing lives in `./parity`. docs/plans/
 * 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U5.
 */

import { internalMutation, mutation } from "../_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id, TableNames } from "../_generated/dataModel";
import { groupOpsByPhase } from "./basePlan";
import type { BaseOp, PhaseTable } from "./basePlan";

export type { BaseOp } from "./basePlan";

/** Bumps the single `proofVehicleMarkers` row, creating it on first use. */
export async function bumpMarker(ctx: MutationCtx): Promise<number> {
	const existing = await ctx.db.query("proofVehicleMarkers").unique();
	if (existing === null) {
		await ctx.db.insert("proofVehicleMarkers", { sequence: 1 });
		return 1;
	}
	const sequence = existing.sequence + 1;
	await ctx.db.patch("proofVehicleMarkers", existing._id, { sequence });
	return sequence;
}

/**
 * KTD4: a separate-session source cannot use the writer's own timestamps,
 * so it subscribes to `proofVehicle/tables:markers` and treats the first
 * source-session transition whose observed sequence is at or past this
 * ack as gate 1's required version.
 */
export const marker = mutation({
	args: {},
	returns: v.object({ marker: v.number() }),
	handler: async (ctx) => ({ marker: await bumpMarker(ctx) }),
});

const PROOF_VEHICLE_TABLES = [
	"likes",
	"messages",
	"memberships",
	"users",
	"rooms",
	"proofVehicleMarkers",
] as const satisfies readonly TableNames[];

/**
 * Destructive: deletes every row in all six proof-vehicle tables (the five
 * contract tables plus the harness-only marker table). Refuses to run
 * unless the deployment env var `PROOF_VEHICLE_FIXTURE` is exactly `"1"`.
 *
 * Review finding #3 (2026-09-28): internal, not public -- the
 * `PROOF_VEHICLE_FIXTURE` guard alone let any connected client wipe every
 * proof-vehicle table on a deployment with the flag set. `npx convex run`
 * (the loader's documented reset command) and convex-test's `t.mutation`
 * can both still call an internal function directly via the admin
 * key/testing backdoor, so this does not change how the CLI or tests reach
 * it.
 */
export const reset = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		if (process.env.PROOF_VEHICLE_FIXTURE !== "1") {
			throw new Error(
				'proofVehicle/fixture:reset refused: set the deployment env var PROOF_VEHICLE_FIXTURE to "1" first (npx convex env set PROOF_VEHICLE_FIXTURE 1).',
			);
		}
		for (const table of PROOF_VEHICLE_TABLES) {
			const rows = await ctx.db.query(table).collect();
			for (const row of rows) {
				await ctx.db.delete(table, row._id);
			}
		}
	},
});

// --- convex-test-side loading (no Convex function wrapper: a pure helper
// used directly by proofVehicle.test.ts; the phase order and message
// ordering come from `./basePlan`, shared with the deployment loader CLI).
// ---

type LabelMaps = {
	rooms: Map<string, Id<"rooms">>;
	users: Map<string, Id<"users">>;
	memberships: Map<string, Id<"memberships">>;
	messages: Map<string, Id<"messages">>;
	likes: Map<string, Id<"likes">>;
};

function resolve(table: "rooms", maps: LabelMaps, label: string): Id<"rooms">;
function resolve(table: "users", maps: LabelMaps, label: string): Id<"users">;
function resolve(table: "memberships", maps: LabelMaps, label: string): Id<"memberships">;
function resolve(table: "messages", maps: LabelMaps, label: string): Id<"messages">;
function resolve(table: "likes", maps: LabelMaps, label: string): Id<"likes">;
function resolve(table: PhaseTable, maps: LabelMaps, label: string): Id<TableNames> {
	const id: Id<TableNames> | undefined = maps[table].get(label);
	if (id === undefined) {
		throw new Error(`loadBaseIntoConvexTest: unbound ${table} label "${label}"`);
	}
	return id;
}

/**
 * Inserts a vector's `base` rows directly (convex-test's counterpart to the
 * deployment loader's phased `npx convex import`), building the same kind
 * of label -> real-id map the deployment loader's ID read-back produces.
 *
 * Phases and message ordering come from `./basePlan.groupOpsByPhase`, the
 * same plan the deployment loader executes: rooms/users (order-
 * independent), then memberships, then messages in ascending
 * `creationTime` order, then likes. Labels resolve out of per-table maps,
 * so a room and a user may share a label without colliding, and a lookup
 * returns the table's own id type with no cast.
 *
 * `ctx.db.insert` has no way to set an explicit `_creationTime` (unlike the
 * deployment loader's phased `npx convex import`, which can), so this
 * cannot honor each `insertMessage` op's literal `creationTime` value --
 * see the plan's Assumptions. Instead convex-test's own monotonically
 * increasing timestamps land in the same *relative* order the corpus
 * specifies. This proves a vector's boundary (which rows are
 * included/excluded and in what order) but not an exact tie between two
 * equal-`creationTime` rows (V4's tie is proven by the snapshot reference
 * run, U11).
 */
export async function loadBaseIntoConvexTest(
	ctx: MutationCtx,
	ops: readonly BaseOp[],
): Promise<Map<string, Id<TableNames>>> {
	const maps: LabelMaps = { rooms: new Map(), users: new Map(), memberships: new Map(), messages: new Map(), likes: new Map() };
	for (const phase of groupOpsByPhase(ops)) {
		for (const op of phase.ops) {
			switch (op.op) {
				case "insertRoom":
					maps.rooms.set(op.label, await ctx.db.insert("rooms", { name: op.name }));
					break;
				case "insertUser":
					maps.users.set(op.label, await ctx.db.insert("users", { name: op.name }));
					break;
				case "insertMembership":
					maps.memberships.set(
						op.label,
						await ctx.db.insert("memberships", {
							room: resolve("rooms", maps, op.room),
							user: resolve("users", maps, op.user),
							active: op.active,
						}),
					);
					break;
				case "insertMessage":
					maps.messages.set(
						op.label,
						await ctx.db.insert("messages", {
							room: resolve("rooms", maps, op.room),
							sender: resolve("users", maps, op.sender),
							body: op.body,
						}),
					);
					break;
				case "insertLike":
					maps.likes.set(
						op.label,
						await ctx.db.insert("likes", {
							message: resolve("messages", maps, op.message),
							user: resolve("users", maps, op.user),
						}),
					);
					break;
			}
		}
	}
	return new Map<string, Id<TableNames>>([
		...maps.rooms,
		...maps.users,
		...maps.memberships,
		...maps.messages,
		...maps.likes,
	]);
}

