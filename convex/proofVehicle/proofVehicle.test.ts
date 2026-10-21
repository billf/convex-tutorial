/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import corpus from "./corpus/v1.json";
import type { BaseOp } from "./fixture";
import {
	type FeedRow,
	roomFeed,
	resolveExpected,
	applyDelta,
	runLoadBase,
	fixtureMarker,
	feedFor,
	seedRoomWithMember,
	type CorpusOutRow,
} from "./testHelpers";

// Absolute-from-project-root pattern (not "../**/*.ts"): this file's own
// sibling modules (feed.ts, tables.ts) would otherwise glob to "./feed.ts"
// instead of "../proofVehicle/feed.ts", which convex-test cannot resolve.
const modules = import.meta.glob("/convex/**/*.ts");


const roomFeedPrefix = makeFunctionReference<"query", { room: Id<"rooms">; n: number }, FeedRow[]>(
	"proofVehicle/feed:roomFeedPrefix",
);

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

const markers = makeFunctionReference<
	"query",
	Record<string, never>,
	{ _id: Id<"proofVehicleMarkers">; _creationTime: number; sequence: number } | null
>("proofVehicle/tables:markers");

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
	// Literal bodies, not just length: the three most recent inserts first.
	expect(prefix3.map((row) => row.body)).toEqual(["m9", "m8", "m7"]);
	// Same predicate, order, and projection as roomFeed, just bounded.
	const full = await t.query(roomFeed, { room });
	expect(prefix3).toEqual(full.slice(0, 3));
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
	// the body arg to the user's id (since "a" is a bound label), silently
	// storing the id string as the body (an id satisfies `v.string()`).
	// The assertion below catches the stored value.
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

// #5: the delta harness resolves nested likes[] label ids for the batch
// txn (M6-class, one level down). Without nested resolution the label
// strings would reach the mutation's `v.id` validators and throw instead
// of landing on the named rows.
test("applyDelta resolves nested likes[] labels for membershipAndLikesBatchTxn", async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const room = await ctx.db.insert("rooms", { name: "r" });
		const user = await ctx.db.insert("users", { name: "u" });
		const membership = await ctx.db.insert("memberships", { room, user, active: true });
		const message = await ctx.db.insert("messages", { room, sender: user, body: "m" });
		return { room, user, membership, message };
	});
	const idByLabel = new Map<string, Id<TableNames>>([
		["r", ids.room],
		["u", ids.user],
		["mem", ids.membership],
		["m", ids.message],
	]);
	const ack = await applyDelta(t, idByLabel, {
		mutation: "membershipAndLikesBatchTxn",
		args: { membership: "mem", active: true, likes: [{ message: "m", user: "u" }] },
	});
	expect(ack.marker).toBeGreaterThan(0);
	const likes = await t.run((ctx) => ctx.db.query("likes").collect());
	expect(likes).toHaveLength(1);
	expect(likes[0]!.message).toBe(ids.message);
	expect(likes[0]!.user).toBe(ids.user);
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
	// Identity, not just counts: a tag rotation or cross-table doc swap
	// must fail even when every count stays 1.
	expect(rows.find((row) => row.table === "rooms")?.doc._id).toBe(room);
	expect(rows.find((row) => row.table === "users")?.doc._id).toBe(user);
	expect(rows.find((row) => row.table === "messages")?.doc.body).toBe("hi");
	expect(rows.find((row) => row.table === "likes")?.doc.message).toBe(messageId);
	expect(rows.find((row) => row.table === "marker")?.doc.sequence).toBe(1);
});


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
	// The literal m51-before-m50 tie-break order is deployment-
	// nondeterministic (Convex assigns IDs randomly); U11 must compare the
	// tied pair as a set, per the corpus vector's own "note" field.
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

// M10 regression: by_room_user has no uniqueness guarantee, so duplicate
// membership rows for one (room, user) pair must not throw -- the pair is
// active when any matching row is active.
test("duplicate membership rows resolve by any-active instead of throwing", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	await t.run((ctx) => ctx.db.insert("messages", { room, sender: user, body: "hi" }));

	// A racing second insert with the opposite flag: still included, no throw.
	await t.run((ctx) => ctx.db.insert("memberships", { room, user, active: false }));
	const included = await t.query(roomFeed, { room });
	expect(included).toHaveLength(1);

	// All rows inactive: excluded, still no throw.
	await t.run((ctx) => ctx.db.patch("memberships", membership, { active: false }));
	const excluded = await t.query(roomFeed, { room });
	expect(excluded).toHaveLength(0);
});

// M3 regression: a leftover/double-run marker row must not make the markers
// query throw -- it reads the latest row.
test("tables:markers returns the latest row when two marker rows exist", async () => {
	const t = convexTest(schema, modules);
	await t.run((ctx) => ctx.db.insert("proofVehicleMarkers", { sequence: 1 }));
	await t.run((ctx) => ctx.db.insert("proofVehicleMarkers", { sequence: 2 }));

	const latest = await t.query(markers, {});
	expect(latest?.sequence).toBe(2);
});

// #6: the read path shares bumpMarker's max-sequence definition of latest,
// so when max-sequence and latest-created disagree the query still returns
// the row the next bump would advance.
test("tables:markers returns the highest sequence when creation order disagrees", async () => {
	const t = convexTest(schema, modules);
	await t.run((ctx) => ctx.db.insert("proofVehicleMarkers", { sequence: 5 }));
	await t.run((ctx) => ctx.db.insert("proofVehicleMarkers", { sequence: 2 }));

	const latest = await t.query(markers, {});
	expect(latest?.sequence).toBe(5);
});

// P1 regression (#2): duplicate marker rows must not brick harness writes.
// bumpMarker picks the highest sequence (not merely the latest-created row),
// advances past it, and deletes the extras so the next bump sees one row.
test("fixture:marker recovers from duplicate marker rows and keeps advancing", async () => {
	const t = convexTest(schema, modules);
	await t.run((ctx) => ctx.db.insert("proofVehicleMarkers", { sequence: 5 }));
	await t.run((ctx) => ctx.db.insert("proofVehicleMarkers", { sequence: 2 }));

	const ack = await t.mutation(fixtureMarker, {});
	expect(ack.marker).toBe(6);

	const rows = await t.run((ctx) => ctx.db.query("proofVehicleMarkers").collect());
	expect(rows).toHaveLength(1);
	expect(rows[0]!.sequence).toBe(6);

	const again = await t.mutation(fixtureMarker, {});
	expect(again.marker).toBe(7);
});
