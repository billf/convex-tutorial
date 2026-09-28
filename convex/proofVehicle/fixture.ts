/**
 * Fixture-lifecycle support: the harness-only marker sequence, the guarded
 * reset, V4's post-bind body patch, and the convex-test-side loading and
 * parity helpers the deployment loader CLI's deployment-side counterparts
 * (`scripts/proof-vehicle-load.ts`) mirror. docs/plans/
 * 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U5.
 */

import { internalMutation, mutation } from "../_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id, TableNames } from "../_generated/dataModel";

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

/**
 * Shared by `patchMessageBody` (this file's V4 post-bind fixture step) and
 * `proofVehicle/mutations:updateMessageBody` (the general Q13 delta
 * mutation); sharing one implementation means they cannot silently diverge.
 * `ctx.db.patch` never touches `_creationTime`
 * (system-assigned at insert, `crates/database/src/transaction.rs:583`),
 * which is exactly the invariant V4's tie depends on.
 */
export async function patchMessageBodyImpl(
	ctx: MutationCtx,
	args: { message: Id<"messages">; body: string },
): Promise<{ affectedIds: { message: Id<"messages"> }; marker: number }> {
	await ctx.db.patch("messages", args.message, { body: args.body });
	return { affectedIds: { message: args.message }, marker: await bumpMarker(ctx) };
}

/**
 * V4's post-bind body patch: after the deployment loader's phased import
 * assigns real IDs to the tied m50/m51 rows, this patches each placeholder
 * body to `message-<bound label>`.
 */
export const patchMessageBody = mutation({
	args: { message: v.id("messages"), body: v.string() },
	returns: v.object({ affectedIds: v.object({ message: v.id("messages") }), marker: v.number() }),
	handler: patchMessageBodyImpl,
});

// --- convex-test-side loading and parity (no Convex function wrapper: pure
// helpers used directly by proofVehicle.test.ts and, in spirit, mirrored by
// the deployment loader CLI's own phased-import + label-binding logic). ---

export type BaseOp =
	| { op: "insertRoom"; label: string; name: string }
	| { op: "insertUser"; label: string; name: string }
	| { op: "insertMembership"; label: string; room: string; user: string; active: boolean }
	| {
			op: "insertMessage";
			label: string;
			room: string;
			sender: string;
			body: string;
			creationTime: number;
	  }
	| { op: "insertLike"; label: string; message: string; user: string };

/**
 * Inserts a vector's `base` rows directly (convex-test's counterpart to the
 * deployment loader's phased `npx convex import`), building the same kind
 * of label -> real-id map the deployment loader's ID read-back produces.
 *
 * `ctx.db.insert` has no way to set an explicit `_creationTime` (unlike the
 * deployment loader's phased `npx convex import`, which can), so this
 * cannot honor each `insertMessage` op's literal `creationTime` value --
 * see the plan's Assumptions. Instead it inserts every non-message row
 * first (order-independent), then inserts message rows in ascending
 * `creationTime` order, so convex-test's own monotonically increasing
 * timestamps land in the same *relative* order the corpus specifies. This
 * proves a vector's boundary (which rows are included/excluded and in what
 * order) but not an exact tie between two equal-`creationTime` rows (V4's
 * tie is proven by the snapshot reference run, U11).
 */
export async function loadBaseIntoConvexTest(
	ctx: MutationCtx,
	ops: readonly BaseOp[],
): Promise<Map<string, Id<TableNames>>> {
	const idByLabel = new Map<string, Id<TableNames>>();
	const resolve = <T extends TableNames>(label: string): Id<T> => {
		const id = idByLabel.get(label);
		if (id === undefined) throw new Error(`loadBaseIntoConvexTest: unbound label "${label}"`);
		return id as Id<T>;
	};

	// Phased, matching each op's foreign-key dependencies: rooms/users have
	// none; memberships need a room and user; messages need a room and
	// sender (and are inserted in ascending creationTime order, the only
	// phase where relative order matters); likes need a message and user.
	for (const op of ops) {
		if (op.op === "insertRoom") {
			idByLabel.set(op.label, await ctx.db.insert("rooms", { name: op.name }));
		} else if (op.op === "insertUser") {
			idByLabel.set(op.label, await ctx.db.insert("users", { name: op.name }));
		}
	}
	for (const op of ops) {
		if (op.op === "insertMembership") {
			idByLabel.set(
				op.label,
				await ctx.db.insert("memberships", {
					room: resolve(op.room),
					user: resolve(op.user),
					active: op.active,
				}),
			);
		}
	}
	const isInsertMessage = (op: BaseOp): op is Extract<BaseOp, { op: "insertMessage" }> =>
		op.op === "insertMessage";
	const orderedMessageOps = ops
		.filter(isInsertMessage)
		.sort((a, b) => a.creationTime - b.creationTime);
	for (const op of orderedMessageOps) {
		idByLabel.set(
			op.label,
			await ctx.db.insert("messages", {
				room: resolve(op.room),
				sender: resolve(op.sender),
				body: op.body,
			}),
		);
	}
	for (const op of ops) {
		if (op.op === "insertLike") {
			idByLabel.set(
				op.label,
				await ctx.db.insert("likes", { message: resolve(op.message), user: resolve(op.user) }),
			);
		}
	}
	return idByLabel;
}

/** One table's golden base-state summary: row count plus a content hash. */
export type TableParity = { count: number; contentHash: string };

/**
 * A label-mapped, deterministic hash of one table's rows: every `_id` and
 * foreign-key `Id` field is replaced by its corpus label (raw IDs always
 * differ between a deployment and convex-test), `_creationTime` is dropped
 * (it is real wall-clock time under convex-test and import-assigned time
 * on a deployment -- neither is reproducible across two independent
 * loads of the same vector, so it is not part of a table's identity for
 * parity purposes; the corpus's own declared creation times are instead
 * checked by the boundary/order tests), rows are sorted by their mapped
 * `_id` for order-independence, and the result is JSON with sorted object
 * keys, hashed with SHA-256. Reproduced by Q's U8 parity function against
 * `corpus/v1.parity.json` / `testdata/v1.parity.json`.
 */
export async function computeParity(
	rows: readonly Record<string, unknown>[],
	labelByRawId: ReadonlyMap<string, string>,
): Promise<TableParity> {
	const ID_LIKE_FIELDS = new Set(["_id", "room", "user", "sender", "message"]);
	const mapValue = (key: string, value: unknown): unknown => {
		if (ID_LIKE_FIELDS.has(key) && typeof value === "string") {
			return labelByRawId.get(value) ?? value;
		}
		return value;
	};
	const mapped = rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(row).sort()) {
			if (key === "_creationTime") continue;
			out[key] = mapValue(key, row[key]);
		}
		return out;
	});
	mapped.sort((a, b) => {
		const ai = String(a["_id"]);
		const bi = String(b["_id"]);
		return ai < bi ? -1 : ai > bi ? 1 : 0;
	});
	const canonical = JSON.stringify(mapped);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	const contentHash = [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return { count: rows.length, contentHash };
}

/** The hash algorithm ID recorded in `corpus/v1.parity.json` / `testdata/v1.parity.json`. */
export const PARITY_HASH_ALGORITHM = "sha256-json-sorted-keys-v1";
