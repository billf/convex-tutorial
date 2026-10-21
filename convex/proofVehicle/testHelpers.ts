/**
 * Shared delta-test harness for the proof-vehicle corpus tests: mutation
 * registry, label resolution, base loading, feeds, and parity hashing.
 * Imported by proofVehicle.test.ts, proofVehicle.mutations.test.ts, and
 * proofVehicle.parity.test.ts -- behavior lives here once.
 */
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type { Id, TableNames } from "../_generated/dataModel";
import { loadBaseIntoConvexTest, type BaseOp } from "./fixture";
export type FeedRow = {
	_id: Id<"messages">;
	_creationTime: number;
	room: Id<"rooms">;
	body: string;
	sender: { _id: Id<"users">; name: string } | null;
	likeCount: number;
};

export const roomFeed = makeFunctionReference<"query", { room: Id<"rooms"> }, FeedRow[]>(
	"proofVehicle/feed:roomFeed",
);
export type Ack = { affectedIds: Record<string, string>; marker: number };
function mutationRef(name: string) {
	return makeFunctionReference<"mutation", Record<string, unknown>, Ack>(name);
}

type MutationTestMeta = {
	bindKey: string;
	idArgKeys: readonly string[];
	nestedIdArgKeys?: Record<string, readonly string[]>;
};

/**
 * The single per-mutation registry (#10): the Convex function path plus
 * the delta-harness metadata that must agree with it. `MUTATIONS` and
 * `MUTATION_TEST_META` below are both derived from this one table, so
 * adding a mutation is a single entry here instead of parallel copies
 * whose keys can silently drift apart.
 */
const MUTATION_DEFS = {
	sendMessage: {
		ref: "proofVehicle/mutations:sendMessage",
		bindKey: "message",
		idArgKeys: ["room", "sender"],
	},
	updateMessageBody: {
		ref: "proofVehicle/mutations:updateMessageBody",
		bindKey: "message",
		idArgKeys: ["message"],
	},
	deleteMessage: {
		ref: "proofVehicle/mutations:deleteMessage",
		bindKey: "message",
		idArgKeys: ["message"],
	},
	renameUser: {
		ref: "proofVehicle/mutations:renameUser",
		bindKey: "user",
		idArgKeys: ["user"],
	},
	deleteUser: {
		ref: "proofVehicle/mutations:deleteUser",
		bindKey: "user",
		idArgKeys: ["user"],
	},
	setMembershipActive: {
		ref: "proofVehicle/mutations:setMembershipActive",
		bindKey: "membership",
		idArgKeys: ["membership"],
	},
	addLike: {
		ref: "proofVehicle/mutations:addLike",
		bindKey: "like",
		idArgKeys: ["message", "user"],
	},
	removeLike: {
		ref: "proofVehicle/mutations:removeLike",
		bindKey: "like",
		idArgKeys: ["like"],
	},
	membershipAndLikesTxn: {
		ref: "proofVehicle/mutations:membershipAndLikesTxn",
		bindKey: "like",
		idArgKeys: ["membership", "message", "user"],
	},
	membershipAndLikesBatchTxn: {
		ref: "proofVehicle/mutations:membershipAndLikesBatchTxn",
		bindKey: "membership",
		idArgKeys: ["membership"],
		nestedIdArgKeys: { likes: ["message", "user"] },
	},
} as const satisfies Record<string, { ref: string } & MutationTestMeta>;

export const MUTATIONS: Record<string, ReturnType<typeof mutationRef>> = Object.fromEntries(
	Object.entries(MUTATION_DEFS).map(([name, def]) => [name, mutationRef(def.ref)]),
);
// One descriptor per mutation for the delta-test harness, derived from
// MUTATION_DEFS above (single source of truth). The fields:
// - `bindKey`: the affectedIds key a delta's `label` should bind to.
//   Needed because Convex's returns validator does not promise to preserve
//   the handler's object-literal key order (membershipAndLikesTxn's
//   {membership, like} does not survive round-trip in insertion order), so
//   a delta's label cannot be bound positionally -- it must name the key
//   explicitly.
// - `idArgKeys`: the arg keys each mutation expects an id (not a literal)
//   for. resolveArgs only rewrites these -- previously it rewrote ANY
//   string arg that happened to match a label, so a delta passing a
//   literal body/name string equal to some other row's label (corpus V2
//   already has both a user labeled "a" and a message body "a") would have
//   silently sent an id where a string was expected.
// - `nestedIdArgKeys`: for mutations taking arrays of id-bearing objects
//   (only `membershipAndLikesBatchTxn`'s `likes[]` today), the per-entry
//   keys to resolve the same way -- without it, label strings inside
//   `likes[]` pass through unresolved and fail the mutation's `v.id`
//   validators (the M6 failure class, one level down).
// Limitation: a delta label still binds a single `affectedIds[bindKey]`
// value, but the batch txn acks `likes` as an *array* -- so no label can
// name a batch-created like, and chained deltas off batch likes are
// inexpressible in this harness today. Name batch-created likes by
// querying them back (as the direct batch tests do), not by label.
export const MUTATION_TEST_META: Record<string, MutationTestMeta> = Object.fromEntries(
	Object.entries(MUTATION_DEFS).map(([name, { ref: _ref, ...meta }]) => [name, meta]),
);
export type CorpusOutRow = {
	id: string;
	creationTime: number;
	room: string;
	body: string;
	sender: { id: string; name: string } | null;
	likeCount: number;
};

export function resolveExpected(row: CorpusOutRow, idByLabel: ReadonlyMap<string, Id<TableNames>>) {
	const id = (label: string) => {
		const resolved = idByLabel.get(label);
		if (resolved === undefined) throw new Error(`resolveExpected: unbound label "${label}"`);
		return resolved;
	};
	return {
		_id: id(row.id),
		room: id(row.room),
		body: row.body,
		sender: row.sender === null ? null : { _id: id(row.sender.id), name: row.sender.name },
		likeCount: row.likeCount,
	};
}

/** Strips `_creationTime` (convex-test can't force the corpus's exact values) before comparing. */
export function withoutCreationTime<T extends { _creationTime: number }>(row: T) {
	const { _creationTime, ...rest } = row;
	return rest;
}
/** Resolves a delta's id-typed `args` (symbolic labels) to real ids via `idByLabel`; literal args pass through unchanged. */
export function resolveArgs(
	mutationName: string,
	args: Record<string, unknown>,
	idByLabel: ReadonlyMap<string, Id<TableNames>>,
): Record<string, unknown> {
	const idKeys = new Set(MUTATION_TEST_META[mutationName]?.idArgKeys ?? []);
	const nestedKeys = MUTATION_TEST_META[mutationName]?.nestedIdArgKeys;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (idKeys.has(key) && typeof value === "string" && idByLabel.has(value)) {
			out[key] = idByLabel.get(value);
		} else if (nestedKeys !== undefined && Array.isArray(value)) {
			out[key] = resolveNestedIds(nestedKeys[key], value, idByLabel);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Resolves label ids inside one array arg's entries (e.g. batch likes[]); entries that are not id-bearing objects pass through unchanged. */
export function resolveNestedIds(
	entryKeys: readonly string[] | undefined,
	entries: unknown[],
	idByLabel: ReadonlyMap<string, Id<TableNames>>,
): unknown[] {
	if (entryKeys === undefined) return entries;
	const keySet = new Set(entryKeys);
	return entries.map((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
		const mapped: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(entry)) {
			mapped[entryKey] =
				keySet.has(entryKey) && typeof entryValue === "string" && idByLabel.has(entryValue)
					? idByLabel.get(entryValue)
					: entryValue;
		}
		return mapped;
	});
}
export async function seedRoomWithMember(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const room = await ctx.db.insert("rooms", { name: "r1" });
		const user = await ctx.db.insert("users", { name: "Alice" });
		const membership = await ctx.db.insert("memberships", { room, user, active: true });
		return { room, user, membership };
	});
}

// convex-test's `t.run` serializes its callback's return value the same
// way a mutation's return value is serialized, and a `Map` is not a
// supported Convex type -- so run the load, then rebuild the Map outside
// `t.run` from a plain entries array.
export async function runLoadBase(
	t: ReturnType<typeof convexTest>,
	ops: BaseOp[],
): Promise<Map<string, Id<TableNames>>> {
	const entries = await t.run(async (ctx) => {
		const map = await loadBaseIntoConvexTest(ctx, ops);
		return [...map.entries()];
	});
	return new Map(entries as [string, Id<TableNames>][]);
}

export async function applyDelta(
	t: ReturnType<typeof convexTest>,
	idByLabel: Map<string, Id<TableNames>>,
	delta: { mutation: string; args: Record<string, unknown>; label?: string },
): Promise<Ack> {
	const ref = MUTATIONS[delta.mutation];
	if (ref === undefined) throw new Error(`applyDelta: unknown mutation "${delta.mutation}"`);
	const ack = await t.mutation(ref, resolveArgs(delta.mutation, delta.args, idByLabel));
	if (delta.label !== undefined) {
		const bindKey = MUTATION_TEST_META[delta.mutation]?.bindKey;
		const bound = bindKey !== undefined ? ack.affectedIds[bindKey] : undefined;
		if (bound === undefined) {
			throw new Error(
				`applyDelta: no MUTATION_TEST_META entry (or no matching affectedIds key) for mutation "${delta.mutation}"`,
			);
		}
		idByLabel.set(delta.label, bound as Id<TableNames>);
	}
	return ack;
}

export async function feedFor(t: ReturnType<typeof convexTest>, room: Id<"rooms">) {
	const rows = await t.query(roomFeed, { room });
	return rows.map(withoutCreationTime);
}

export const fixtureMarker = makeFunctionReference<"mutation", Record<string, never>, { marker: number }>(
	"proofVehicle/fixture:marker",
);
export const fixtureReset = makeFunctionReference<"mutation", Record<string, never>, null>(
	"proofVehicle/fixture:reset",
);
export const patchMessageBody = mutationRef("proofVehicle/fixture:patchMessageBody");

// Re-exported for the V4 tie-break unit pin (see proofVehicle.test.ts):
// hermetic tests cannot reproduce equal `_creationTime` rows through
// inserts, so the comparator leg is tested directly instead.
export { compareDesc } from "./feed";
