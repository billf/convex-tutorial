/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

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

async function seedRoomWithMember(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const room = await ctx.db.insert("rooms", { name: "r1" });
		const user = await ctx.db.insert("users", { name: "Alice" });
		await ctx.db.insert("memberships", { room, user, active: true });
		return { room, user };
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
