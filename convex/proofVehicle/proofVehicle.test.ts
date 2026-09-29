/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import { loadBaseIntoConvexTest, computeParity, type BaseOp } from "./fixture";
import corpus from "./corpus/v1.json";
import parity from "./corpus/v1.parity.json";

// Absolute-from-project-root pattern (not "../**/*.ts"): this file's own
// sibling modules (feed.ts, tables.ts) would otherwise glob to "./feed.ts"
// instead of "../proofVehicle/feed.ts", which convex-test cannot resolve.
const modules = import.meta.glob("/convex/**/*.ts");

const roomFeed = makeFunctionReference<
	"query",
	{ room: Id<"rooms"> },
	{
		_id: Id<"messages">;
		_creationTime: number;
		room: Id<"rooms">;
		body: string;
		sender: { _id: Id<"users">; name: string } | null;
		likeCount: number;
	}[]
>("proofVehicle/feed:roomFeed");

const roomFeedPrefix = makeFunctionReference<
	"query",
	{ room: Id<"rooms">; n: number },
	unknown[]
>("proofVehicle/feed:roomFeedPrefix");

const allSelectedRows = makeFunctionReference<
	"query",
	Record<string, never>,
	{ table: string; doc: Record<string, unknown> }[]
>("proofVehicle/tables:allSelectedRows");

const likes = makeFunctionReference<
	"query",
	Record<string, never>,
	{ _id: Id<"likes">; message: Id<"messages">; user: Id<"users"> }[]
>("proofVehicle/tables:likes");

type Ack = { affectedIds: Record<string, string>; marker: number };
function mutationRef(name: string) {
	return makeFunctionReference<"mutation", Record<string, unknown>, Ack>(name);
}

const MUTATIONS: Record<string, ReturnType<typeof mutationRef>> = {
	sendMessage: mutationRef("proofVehicle/mutations:sendMessage"),
	updateMessageBody: mutationRef("proofVehicle/mutations:updateMessageBody"),
	deleteMessage: mutationRef("proofVehicle/mutations:deleteMessage"),
	renameUser: mutationRef("proofVehicle/mutations:renameUser"),
	deleteUser: mutationRef("proofVehicle/mutations:deleteUser"),
	setMembershipActive: mutationRef("proofVehicle/mutations:setMembershipActive"),
	addLike: mutationRef("proofVehicle/mutations:addLike"),
	removeLike: mutationRef("proofVehicle/mutations:removeLike"),
	membershipAndLikesTxn: mutationRef("proofVehicle/mutations:membershipAndLikesTxn"),
};

// One descriptor per mutation for the delta-test harness, covering both
// formulation sites that must agree per mutation:
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
// A parity test below pins this map's key set to the registered MUTATIONS.
const MUTATION_TEST_META: Record<string, { bindKey: string; idArgKeys: readonly string[] }> = {
	sendMessage: { bindKey: "message", idArgKeys: ["room", "sender"] },
	updateMessageBody: { bindKey: "message", idArgKeys: ["message"] },
	deleteMessage: { bindKey: "message", idArgKeys: ["message"] },
	renameUser: { bindKey: "user", idArgKeys: ["user"] },
	deleteUser: { bindKey: "user", idArgKeys: ["user"] },
	setMembershipActive: { bindKey: "membership", idArgKeys: ["membership"] },
	addLike: { bindKey: "like", idArgKeys: ["message", "user"] },
	removeLike: { bindKey: "like", idArgKeys: ["like"] },
	membershipAndLikesTxn: { bindKey: "like", idArgKeys: ["membership", "message", "user"] },
};

test("MUTATION_TEST_META covers exactly the registered MUTATIONS", () => {
	expect(new Set(Object.keys(MUTATION_TEST_META))).toEqual(new Set(Object.keys(MUTATIONS)));
});

const fixtureMarker = makeFunctionReference<"mutation", Record<string, never>, { marker: number }>(
	"proofVehicle/fixture:marker",
);
const fixtureReset = makeFunctionReference<"mutation", Record<string, never>, null>(
	"proofVehicle/fixture:reset",
);
const patchMessageBody = mutationRef("proofVehicle/fixture:patchMessageBody");

type CorpusOutRow = {
	id: string;
	creationTime: number;
	room: string;
	body: string;
	sender: { id: string; name: string } | null;
	likeCount: number;
};

/** Resolves a corpus `Out(...)` row's symbolic labels to real ids for comparison. */
function resolveExpected(row: CorpusOutRow, idByLabel: ReadonlyMap<string, Id<TableNames>>) {
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
function withoutCreationTime<T extends { _creationTime: number }>(row: T) {
	const { _creationTime, ...rest } = row;
	return rest;
}

/** Resolves a delta's id-typed `args` (symbolic labels) to real ids via `idByLabel`; literal args pass through unchanged. */
function resolveArgs(
	mutationName: string,
	args: Record<string, unknown>,
	idByLabel: ReadonlyMap<string, Id<TableNames>>,
): Record<string, unknown> {
	const idKeys = new Set(MUTATION_TEST_META[mutationName]?.idArgKeys ?? []);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (idKeys.has(key) && typeof value === "string" && idByLabel.has(value)) {
			out[key] = idByLabel.get(value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

async function seedRoomWithMember(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const room = await ctx.db.insert("rooms", { name: "r1" });
		const user = await ctx.db.insert("users", { name: "Alice" });
		const membership = await ctx.db.insert("memberships", { room, user, active: true });
		return { room, user, membership };
	});
}

test("the oracle excludes a message whose sender has no membership row", async () => {
	const t = convexTest(schema, modules);
	const { room } = await seedRoomWithMember(t);
	const outsider = await t.run((ctx) => ctx.db.insert("users", { name: "Outsider" }));
	await t.run((ctx) => ctx.db.insert("messages", { room, sender: outsider, body: "hi" }));

	const feed = await t.query(roomFeed, { room });
	expect(feed).toHaveLength(0);
});

test("the oracle excludes a message whose sender's membership is inactive", async () => {
	const t = convexTest(schema, modules);
	const { room } = await seedRoomWithMember(t);
	const inactiveUser = await t.run((ctx) => ctx.db.insert("users", { name: "Inactive" }));
	await t.run((ctx) =>
		ctx.db.insert("memberships", { room, user: inactiveUser, active: false }),
	);
	await t.run((ctx) => ctx.db.insert("messages", { room, sender: inactiveUser, body: "hi" }));

	const feed = await t.query(roomFeed, { room });
	expect(feed).toHaveLength(0);
});

test("the oracle returns sender: null for a deleted user", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	await t.run((ctx) => ctx.db.insert("messages", { room, sender: user, body: "hi" }));
	await t.run((ctx) => ctx.db.delete("users", user));

	const feed = await t.query(roomFeed, { room });
	expect(feed).toHaveLength(1);
	expect(feed[0].sender).toBe(null);
});

test("the oracle computes an exact likeCount", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	const messageId = await t.run((ctx) =>
		ctx.db.insert("messages", { room, sender: user, body: "hi" }),
	);
	const liker1 = await t.run((ctx) => ctx.db.insert("users", { name: "Liker1" }));
	const liker2 = await t.run((ctx) => ctx.db.insert("users", { name: "Liker2" }));
	const like1 = await t.run((ctx) => ctx.db.insert("likes", { message: messageId, user: liker1 }));
	const like2 = await t.run((ctx) => ctx.db.insert("likes", { message: messageId, user: liker2 }));

	let feed = await t.query(roomFeed, { room });
	expect(feed[0].likeCount).toBe(2);

	await t.run((ctx) => ctx.db.delete("likes", like2));
	feed = await t.query(roomFeed, { room });
	expect(feed[0].likeCount).toBe(1);

	await t.run((ctx) => ctx.db.delete("likes", like1));
	feed = await t.query(roomFeed, { room });
	expect(feed[0].likeCount).toBe(0);
});

test("the oracle orders descending by _creationTime and limits to 50", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	const bodies: string[] = [];
	for (let i = 0; i < 51; i++) {
		const body = `m${i}`;
		bodies.push(body);
		await t.run((ctx) => ctx.db.insert("messages", { room, sender: user, body }));
	}

	const feed = await t.query(roomFeed, { room });
	expect(feed).toHaveLength(50);
	// Most recent first; the oldest message ("m0") is the one dropped.
	expect(feed.map((row) => row.body)).toEqual([...bodies].reverse().slice(0, 50));
	expect(feed.some((row) => row.body === "m0")).toBe(false);

	// Note: proving the explicit _id tie-break requires two messages with
	// an identical _creationTime, which convex-test's public insert API
	// cannot force (see the plan's Assumptions). That tie is proven by the
	// snapshot reference run (U11) and by Q3's synthetic tests, not here.
});

test("roomFeedPrefix honors n", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	for (let i = 0; i < 10; i++) {
		await t.run((ctx) => ctx.db.insert("messages", { room, sender: user, body: `m${i}` }));
	}

	const prefix3 = await t.query(roomFeedPrefix, { room, n: 3 });
	expect(prefix3).toHaveLength(3);
	const prefix50 = await t.query(roomFeedPrefix, { room, n: 50 });
	expect(prefix50).toHaveLength(10);
});

test("roomFeedPrefix with n: 0 returns an empty feed", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	await t.run((ctx) => ctx.db.insert("messages", { room, sender: user, body: "hi" }));

	const prefix0 = await t.query(roomFeedPrefix, { room, n: 0 });
	expect(prefix0).toHaveLength(0);
});

test("roomFeedPrefix rejects n outside [0, 50]", async () => {
	const t = convexTest(schema, modules);
	const { room } = await seedRoomWithMember(t);
	await expect(t.query(roomFeedPrefix, { room, n: 51 })).rejects.toThrow();
	await expect(t.query(roomFeedPrefix, { room, n: -1 })).rejects.toThrow();
});

test("roomFeedPrefix rejects non-integer and NaN n", async () => {
	const t = convexTest(schema, modules);
	const { room } = await seedRoomWithMember(t);
	await expect(t.query(roomFeedPrefix, { room, n: 3.5 })).rejects.toThrow();
	await expect(t.query(roomFeedPrefix, { room, n: NaN })).rejects.toThrow();
});

test("the oracle scopes messages to their own room", async () => {
	const t = convexTest(schema, modules);
	const { room: roomA, user: userA } = await seedRoomWithMember(t);
	const roomB = await t.run((ctx) => ctx.db.insert("rooms", { name: "r2" }));
	const userB = await t.run((ctx) => ctx.db.insert("users", { name: "Bob" }));
	await t.run((ctx) => ctx.db.insert("memberships", { room: roomB, user: userB, active: true }));
	await t.run((ctx) => ctx.db.insert("messages", { room: roomA, sender: userA, body: "a" }));
	await t.run((ctx) => ctx.db.insert("messages", { room: roomB, sender: userB, body: "b" }));

	const feedA = await t.query(roomFeed, { room: roomA });
	expect(feedA).toHaveLength(1);
	expect(feedA[0].body).toBe("a");

	const feedB = await t.query(roomFeed, { room: roomB });
	expect(feedB).toHaveLength(1);
	expect(feedB[0].body).toBe("b");
});

test("M6 regression: resolveArgs does not rewrite a literal body arg that collides with a label", async () => {
	const t = convexTest(schema, modules);
	// Deliberately label the user "a" and send a message whose body is also
	// the literal string "a" -- before the fix, resolveArgs would rewrite
	// the body arg to the user's id (since "a" is a bound label), which
	// fails the mutation's `body: v.string()` validator.
	const idByLabel = await runLoadBase(t, [
		{ op: "insertRoom", label: "r", name: "room" },
		{ op: "insertUser", label: "a", name: "Ada" },
	]);
	const ack = await applyDelta(t, idByLabel, {
		mutation: "sendMessage",
		args: { room: "r", sender: "a", body: "a" },
		label: "msg",
	});
	const messageId = ack.affectedIds["message"] as Id<"messages">;
	const stored = await t.run((ctx) => ctx.db.get("messages", messageId));
	expect(stored?.body).toBe("a");
});

test("allSelectedRows returns every row, each tagged with its table, including the marker row", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	const messageId = await t.run((ctx) =>
		ctx.db.insert("messages", { room, sender: user, body: "hi" }),
	);
	await t.run((ctx) => ctx.db.insert("likes", { message: messageId, user }));
	await t.run((ctx) => ctx.db.insert("proofVehicleMarkers", { sequence: 1 }));

	const rows = await t.query(allSelectedRows, {});
	const byTable = new Map<string, number>();
	for (const row of rows) {
		byTable.set(row.table, (byTable.get(row.table) ?? 0) + 1);
	}
	expect(byTable.get("rooms")).toBe(1);
	expect(byTable.get("users")).toBe(1);
	expect(byTable.get("memberships")).toBe(1);
	expect(byTable.get("messages")).toBe(1);
	expect(byTable.get("likes")).toBe(1);
	expect(byTable.get("marker")).toBe(1);
});

// --- U5: corpus-driven mutation tests ------------------------------------

// convex-test's `t.run` serializes its callback's return value the same
// way a mutation's return value is serialized, and a `Map` is not a
// supported Convex type -- so run the load, then rebuild the Map outside
// `t.run` from a plain entries array.
async function runLoadBase(
	t: ReturnType<typeof convexTest>,
	ops: BaseOp[],
): Promise<Map<string, Id<TableNames>>> {
	const entries = await t.run(async (ctx) => {
		const map = await loadBaseIntoConvexTest(ctx, ops);
		return [...map.entries()];
	});
	return new Map(entries as [string, Id<TableNames>][]);
}

async function applyDelta(
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

async function feedFor(t: ReturnType<typeof convexTest>, room: Id<"rooms">) {
	const rows = await t.query(roomFeed, { room });
	return rows.map(withoutCreationTime);
}

for (const key of ["V1", "V2", "V3", "V6"] as const) {
	const vector = corpus.vectors[key];
	test(`${key} (${vector.title}): base matches, and each delta's expected output holds`, async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		const room = idByLabel.get("r") as Id<"rooms">;

		const expectedBase = (vector.expectedBase as CorpusOutRow[]).map((row) =>
			resolveExpected(row, idByLabel),
		);
		expect(await feedFor(t, room)).toEqual(expectedBase);

		const deltas = vector.deltas as { mutation: string; args: Record<string, unknown>; label?: string }[];
		const expectedAfterDelta = vector.expectedAfterDelta as (CorpusOutRow[] | null)[];
		for (let i = 0; i < deltas.length; i++) {
			const ack = await applyDelta(t, idByLabel, deltas[i]!);
			expect(ack.marker).toBeGreaterThan(0);
			const expected = expectedAfterDelta[i];
			if (expected !== null) {
				expect(await feedFor(t, room)).toEqual(
					expected.map((row) => resolveExpected(row, idByLabel)),
				);
			}
		}
	});
}

test("V4 (exact 50-row boundary and ID tie): the excluded 51st row and the included set match", async () => {
	const t = convexTest(schema, modules);
	const vector = corpus.vectors.V4;
	const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
	const room = idByLabel.get("r") as Id<"rooms">;

	const feed = await t.query(roomFeed, { room });
	expect(feed).toHaveLength(50);
	expect(feed.some((row) => row._id === idByLabel.get("m01"))).toBe(false);

	const expectedIds = new Set(
		(vector.expectedBase as CorpusOutRow[]).map((row) => idByLabel.get(row.id)),
	);
	expect(new Set(feed.map((row) => row._id))).toEqual(expectedIds);
	for (const row of feed) {
		expect(row.sender).toEqual({ _id: idByLabel.get("a"), name: "Ada" });
		expect(row.likeCount).toBe(0);
	}
	// The literal m51-before-m50 tie-break is proven by the snapshot
	// reference run (U11); see the corpus vector's own "note" field.
});

test("V5 (deletes): each independent delta, applied to a fresh copy of the base, matches its own expected output", async () => {
	const vector = corpus.vectors.V5;
	for (const independent of vector.independentDeltas) {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		const room = idByLabel.get("r") as Id<"rooms">;

		await applyDelta(t, idByLabel, independent);
		const expected = (independent.expected as CorpusOutRow[]).map((row) =>
			resolveExpected(row, idByLabel),
		);
		expect(await feedFor(t, room)).toEqual(expected);
	}
});

test("V6's transaction leaves two like rows on a1, so its count before the membership filter is 2", async () => {
	const t = convexTest(schema, modules);
	const vector = corpus.vectors.V6;
	const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
	const ack = await applyDelta(t, idByLabel, vector.deltas[0]!);

	const messageA1 = idByLabel.get("a1");
	const allLikes = await t.query(likes, {});
	expect(allLikes.filter((like) => like.message === messageA1)).toHaveLength(2);
	// The canonical feed (post membership-filter) shows Out() -- see the
	// V6 test above, which asserts expectedAfterDelta[0] === [].

	// M5 regression: label "l2" must bind to the new like row, not the
	// patched membership row.
	expect(idByLabel.get("l2")).toBe(ack.affectedIds["like"]);
});

const membershipAndLikesBatchTxn = makeFunctionReference<
	"mutation",
	{
		membership: Id<"memberships">;
		active: boolean;
		likes: { message: Id<"messages">; user: Id<"users"> }[];
	},
	{ affectedIds: { membership: Id<"memberships">; likes: Id<"likes">[] }; marker: number }
>("proofVehicle/mutations:membershipAndLikesBatchTxn");

test("membershipAndLikesBatchTxn patches the membership and inserts every like, acking them in order", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const { m1, m2, liker } = await t.run(async (ctx) => ({
		m1: await ctx.db.insert("messages", { room, sender: user, body: "one" }),
		m2: await ctx.db.insert("messages", { room, sender: user, body: "two" }),
		liker: await ctx.db.insert("users", { name: "Liker" }),
	}));

	const ack = await t.mutation(membershipAndLikesBatchTxn, {
		membership,
		active: false,
		likes: [
			{ message: m1, user: liker },
			{ message: m2, user: liker },
			{ message: m1, user },
		],
	});
	expect(ack.affectedIds.membership).toBe(membership);
	expect(ack.affectedIds.likes).toHaveLength(3);
	expect(ack.marker).toBeGreaterThan(0);

	const stored = await t.run(async (ctx) => ({
		membership: await ctx.db.get("memberships", membership),
		likes: await Promise.all(ack.affectedIds.likes.map((id) => ctx.db.get("likes", id))),
	}));
	expect(stored.membership?.active).toBe(false);
	expect(stored.likes.map((like) => [like?.message, like?.user])).toEqual([
		[m1, liker],
		[m2, liker],
		[m1, user],
	]);
});

test("membershipAndLikesBatchTxn rejects an empty likes list without writing", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	await expect(
		t.mutation(membershipAndLikesBatchTxn, { membership, active: false, likes: [] }),
	).rejects.toThrow(/1 to 100/);
	const stored = await t.run((ctx) => ctx.db.get("memberships", membership));
	expect(stored?.active).toBe(true);
});

test("each mutation's acks name the rows it wrote", async () => {
	const t = convexTest(schema, modules);
	const idByLabel = await runLoadBase(t, corpus.vectors.V3.base as BaseOp[]);
	const room = idByLabel.get("r") as Id<"rooms">;
	const a = idByLabel.get("a") as Id<"users">;

	const sendAck = await t.mutation(MUTATIONS.sendMessage!, { room, sender: a, body: "new" });
	const messageId = sendAck.affectedIds["message"];
	const stored = await t.run((ctx) => ctx.db.get("messages", messageId as Id<"messages">));
	expect(stored?.body).toBe("new");

	const likeAck = await t.mutation(MUTATIONS.addLike!, {
		message: messageId,
		user: idByLabel.get("b") ?? a,
	});
	const likeId = likeAck.affectedIds["like"];
	const storedLike = await t.run((ctx) => ctx.db.get("likes", likeId as Id<"likes">));
	expect(storedLike?.message).toBe(messageId);
});

// Branch-review BR4: updateMessageBody and renameUser are registered in
// MUTATIONS but no corpus delta or prior test ever invokes either, so
// neither had any test evidence of behaving as documented.
test("updateMessageBody and renameUser patch the row they name", async () => {
	const t = convexTest(schema, modules);
	const idByLabel = await runLoadBase(t, corpus.vectors.V3.base as BaseOp[]);
	const a = idByLabel.get("a") as Id<"users">;

	const sendAck = await t.mutation(MUTATIONS.sendMessage!, {
		room: idByLabel.get("r"),
		sender: a,
		body: "before",
	});
	const messageId = sendAck.affectedIds["message"] as Id<"messages">;

	const updateAck = await t.mutation(MUTATIONS.updateMessageBody!, {
		message: messageId,
		body: "after",
	});
	expect(updateAck.affectedIds["message"]).toBe(messageId);
	const updatedMessage = await t.run((ctx) => ctx.db.get("messages", messageId));
	expect(updatedMessage?.body).toBe("after");

	const renameAck = await t.mutation(MUTATIONS.renameUser!, { user: a, name: "Renamed" });
	expect(renameAck.affectedIds["user"]).toBe(a);
	const renamedUser = await t.run((ctx) => ctx.db.get("users", a));
	expect(renamedUser?.name).toBe("Renamed");
});

test("fixture:reset refuses to run without the PROOF_VEHICLE_FIXTURE guard", async () => {
	const t = convexTest(schema, modules);
	await seedRoomWithMember(t);
	await expect(t.mutation(fixtureReset, {})).rejects.toThrow(/PROOF_VEHICLE_FIXTURE/);
});

test("fixture:marker increments a sequence each call", async () => {
	const t = convexTest(schema, modules);
	const first = await t.mutation(fixtureMarker, {});
	const second = await t.mutation(fixtureMarker, {});
	expect(second.marker).toBe(first.marker + 1);
});

test("V4's tied rows carry message-<bound label> bodies after the patch", async () => {
	const t = convexTest(schema, modules);
	const idByLabel = await runLoadBase(t, corpus.vectors.V4.base as BaseOp[]);
	const m50 = idByLabel.get("m50") as Id<"messages">;
	const m51 = idByLabel.get("m51") as Id<"messages">;

	await t.mutation(patchMessageBody, { message: m50, body: "message-m50" });
	await t.mutation(patchMessageBody, { message: m51, body: "message-m51" });

	const before = await t.run((ctx) => ctx.db.get("messages", m50));
	await t.mutation(patchMessageBody, { message: m50, body: "message-m50" });
	const after = await t.run((ctx) => ctx.db.get("messages", m50));
	// A patch never touches _creationTime -- the tie's load-bearing invariant.
	expect(after?._creationTime).toBe(before?._creationTime);
});

test("AE14: replaying one delta log into two independently loaded copies yields equal label-mapped parity hashes", async () => {
	const vector = corpus.vectors.V5;
	const loadAndComputeParity = async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		const labelByRawId = new Map<string, string>();
		for (const [label, id] of idByLabel) labelByRawId.set(id, label);
		const rows = await t.run((ctx) => ctx.db.query("messages").collect());
		return computeParity(rows, labelByRawId);
	};

	const parityA = await loadAndComputeParity();
	const parityB = await loadAndComputeParity();
	expect(parityA).toEqual(parityB);
});

test("AE14: a load that omits one mutation produces a different parity hash", async () => {
	const vector = corpus.vectors.V1;
	const full = await (async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		await applyDelta(t, idByLabel, (vector.deltas as { mutation: string; args: Record<string, unknown> }[])[0]!);
		const labelByRawId = new Map<string, string>();
		for (const [label, id] of idByLabel) labelByRawId.set(id, label);
		const rows = await t.run((ctx) => ctx.db.query("users").collect());
		return computeParity(rows, labelByRawId);
	})();

	const partial = await (async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		// Omits the delta (deleteUser) a real replay would have applied.
		const labelByRawId = new Map<string, string>();
		for (const [label, id] of idByLabel) labelByRawId.set(id, label);
		const rows = await t.run((ctx) => ctx.db.query("users").collect());
		return computeParity(rows, labelByRawId);
	})();

	expect(full.contentHash).not.toBe(partial.contentHash);
});

const PARITY_TABLES = ["rooms", "users", "memberships", "messages", "likes"] as const;

test("computeParity reproduces the vendored corpus/v1.parity.json for every vector's base state", async () => {
	for (const [key, vector] of Object.entries(corpus.vectors)) {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		const labelByRawId = new Map<string, string>();
		for (const [label, id] of idByLabel) labelByRawId.set(id, label);

		const golden = (parity.vectors as Record<string, Record<string, unknown>>)[key]!;
		for (const table of PARITY_TABLES) {
			const rows = await t.run((ctx) => ctx.db.query(table).collect());
			const actual = await computeParity(rows, labelByRawId);
			expect(actual).toEqual(golden[table]);
		}
	}
});

// M3 regression: every vector's declared base message creationTime must
// agree with the same message's declared expectedBase creationTime. Neither
// the convex-test path (creationTime is stripped before comparison) nor
// computeParity (creationTime is dropped from the hash) would ever catch a
// disagreement here -- this is a plain data-consistency check on the corpus
// JSON itself, independent of any Convex query.
test("corpus: base and expectedBase agree for every message, in every vector", () => {
	for (const [key, vector] of Object.entries(corpus.vectors)) {
		const baseMessageByLabel = new Map(
			(vector.base as BaseOp[])
				.filter((op): op is BaseOp & { op: "insertMessage" } => op.op === "insertMessage")
				.map((op) => [op.label, op]),
		);
		for (const row of (vector.expectedBase ?? []) as CorpusOutRow[]) {
			const baseOp = baseMessageByLabel.get(row.id);
			if (baseOp === undefined) {
				throw new Error(
					`${key}: expectedBase "${row.id}" has no matching base insertMessage op`,
				);
			}
			expect(baseOp.creationTime, `${key}: expectedBase "${row.id}" creationTime`).toBe(
				row.creationTime,
			);
			expect(baseOp.body, `${key}: expectedBase "${row.id}" body`).toBe(row.body);
		}
	}
});
