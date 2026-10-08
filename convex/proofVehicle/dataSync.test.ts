/// <reference types="vite/client" />
/**
 * 1c U5's test scenarios (docs/plans/
 * 2026-09-10-1854-feat-skip-data-sync-push-source-spike-plan.md, U5), run
 * against Q13's public fixture functions. 1c adds no fixture code of its
 * own: these tests pin the behavior its Data Sync push source and
 * comparison harness (U4, U6) rely on. Each harness mutation gets an
 * independently computed expected feed, and the bounded correctness oracle
 * (`roomFeed`) is kept distinct from the monolithic `O(N)` snapshot
 * baseline (`allSelectedRows`, KTD11).
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

// Absolute-from-project-root glob; see proofVehicle.test.ts.
const modules = import.meta.glob("/convex/**/*.ts");

type FeedRow = {
	_id: Id<"messages">;
	_creationTime: number;
	room: Id<"rooms">;
	body: string;
	sender: { _id: Id<"users">; name: string } | null;
	likeCount: number;
};

const roomFeed = makeFunctionReference<"query", { room: Id<"rooms"> }, FeedRow[]>(
	"proofVehicle/feed:roomFeed",
);
const allSelectedRows = makeFunctionReference<
	"query",
	Record<string, never>,
	{ table: string; doc: { _id: string } }[]
>("proofVehicle/tables:allSelectedRows");

type Ack<K extends string, V = string> = { affectedIds: Record<K, V>; marker: number };
const sendMessage = makeFunctionReference<
	"mutation",
	{ room: Id<"rooms">; sender: Id<"users">; body: string },
	Ack<"message", Id<"messages">>
>("proofVehicle/mutations:sendMessage");
const updateMessageBody = makeFunctionReference<
	"mutation",
	{ message: Id<"messages">; body: string },
	Ack<"message">
>("proofVehicle/mutations:updateMessageBody");
const deleteMessage = makeFunctionReference<
	"mutation",
	{ message: Id<"messages"> },
	Ack<"message">
>("proofVehicle/mutations:deleteMessage");
const renameUser = makeFunctionReference<
	"mutation",
	{ user: Id<"users">; name: string },
	Ack<"user">
>("proofVehicle/mutations:renameUser");
const deleteUser = makeFunctionReference<"mutation", { user: Id<"users"> }, Ack<"user">>(
	"proofVehicle/mutations:deleteUser",
);
const setMembershipActive = makeFunctionReference<
	"mutation",
	{ membership: Id<"memberships">; active: boolean },
	Ack<"membership">
>("proofVehicle/mutations:setMembershipActive");
const addLike = makeFunctionReference<
	"mutation",
	{ message: Id<"messages">; user: Id<"users"> },
	Ack<"like", Id<"likes">>
>("proofVehicle/mutations:addLike");
const removeLike = makeFunctionReference<"mutation", { like: Id<"likes"> }, Ack<"like">>(
	"proofVehicle/mutations:removeLike",
);
const membershipAndLikesBatchTxn = makeFunctionReference<
	"mutation",
	{
		membership: Id<"memberships">;
		active: boolean;
		likes: { message: Id<"messages">; user: Id<"users"> }[];
	},
	{ affectedIds: { membership: Id<"memberships">; likes: Id<"likes">[] }; marker: number }
>("proofVehicle/mutations:membershipAndLikesBatchTxn");

type T = ReturnType<typeof convexTest>;

/** One room with two active members, Ada and Bo, and one outsider, Cy. */
async function seedRoom(t: T) {
	return t.run(async (ctx) => {
		const room = await ctx.db.insert("rooms", { name: "r" });
		const ada = await ctx.db.insert("users", { name: "Ada" });
		const bo = await ctx.db.insert("users", { name: "Bo" });
		const cy = await ctx.db.insert("users", { name: "Cy" });
		const adaMembership = await ctx.db.insert("memberships", { room, user: ada, active: true });
		const boMembership = await ctx.db.insert("memberships", { room, user: bo, active: true });
		return { room, ada, bo, cy, adaMembership, boMembership };
	});
}

async function send(t: T, room: Id<"rooms">, sender: Id<"users">, body: string) {
	return (await t.mutation(sendMessage, { room, sender, body })).affectedIds.message;
}

/** The feed as `[body, senderName, likeCount]` triples, newest first. */
async function feedSummary(t: T, room: Id<"rooms">) {
	const rows = await t.query(roomFeed, { room });
	return rows.map((row) => [row.body, row.sender?.name ?? null, row.likeCount]);
}

test("updating and deleting a message changes the bounded proof result deterministically", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo } = await seedRoom(t);
	const m1 = await send(t, room, ada, "one");
	await send(t, room, bo, "two");

	await t.mutation(updateMessageBody, { message: m1, body: "one, edited" });
	const afterUpdate = await t.query(roomFeed, { room });
	expect(afterUpdate.map((row) => row.body)).toEqual(["two", "one, edited"]);
	// A body patch keeps the row's identity and position.
	expect(afterUpdate[1]!._id).toBe(m1);

	await t.mutation(deleteMessage, { message: m1 });
	expect(await feedSummary(t, room)).toEqual([["two", "Bo", 0]]);

	// Replaying the same mutations on a fresh copy reaches the same feed.
	const t2 = convexTest(schema, modules);
	const seed2 = await seedRoom(t2);
	const n1 = await send(t2, seed2.room, seed2.ada, "one");
	await send(t2, seed2.room, seed2.bo, "two");
	await t2.mutation(updateMessageBody, { message: n1, body: "one, edited" });
	await t2.mutation(deleteMessage, { message: n1 });
	expect(await feedSummary(t2, seed2.room)).toEqual(await feedSummary(t, room));
});

test("renaming a user updates every joined message name; deleting the user keeps messages with a null sender", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo } = await seedRoom(t);
	await send(t, room, ada, "a1");
	await send(t, room, bo, "b1");
	await send(t, room, ada, "a2");

	await t.mutation(renameUser, { user: ada, name: "Ada L." });
	expect(await feedSummary(t, room)).toEqual([
		["a2", "Ada L.", 0],
		["b1", "Bo", 0],
		["a1", "Ada L.", 0],
	]);

	await t.mutation(deleteUser, { user: ada });
	const feed = await t.query(roomFeed, { room });
	expect(feed.map((row) => [row.body, row.sender])).toEqual([
		["a2", null],
		["b1", { _id: bo, name: "Bo" }],
		["a1", null],
	]);
});

test("toggling a membership includes or excludes that sender's messages", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo, boMembership } = await seedRoom(t);
	await send(t, room, ada, "a1");
	await send(t, room, bo, "b1");

	await t.mutation(setMembershipActive, { membership: boMembership, active: false });
	expect(await feedSummary(t, room)).toEqual([["a1", "Ada", 0]]);

	await t.mutation(setMembershipActive, { membership: boMembership, active: true });
	expect(await feedSummary(t, room)).toEqual([
		["b1", "Bo", 0],
		["a1", "Ada", 0],
	]);
});

test("adding or deleting a like changes only that message's likeCount", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo } = await seedRoom(t);
	const m1 = await send(t, room, ada, "a1");
	await send(t, room, bo, "b1");
	const before = await t.query(roomFeed, { room });

	const like = (await t.mutation(addLike, { message: m1, user: bo })).affectedIds.like;
	const afterAdd = await t.query(roomFeed, { room });
	expect(afterAdd).toEqual(
		before.map((row) => (row._id === m1 ? { ...row, likeCount: 1 } : row)),
	);

	await t.mutation(removeLike, { like });
	expect(await t.query(roomFeed, { room })).toEqual(before);
});

test("one multi-table mutation changes a membership and several likes in one transaction, acking deterministic ids", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo, cy, boMembership } = await seedRoom(t);
	const a1 = await send(t, room, ada, "a1");
	await send(t, room, bo, "b1");
	const a2 = await send(t, room, ada, "a2");

	const ack = await t.mutation(membershipAndLikesBatchTxn, {
		membership: boMembership,
		active: false,
		likes: [
			{ message: a1, user: bo },
			{ message: a2, user: cy },
			{ message: a1, user: cy },
		],
	});

	// Both halves are visible together: Bo's message leaves the feed and
	// every like lands.
	expect(await feedSummary(t, room)).toEqual([
		["a2", "Ada", 1],
		["a1", "Ada", 2],
	]);

	// The ack names exactly the rows written, in request order.
	expect(ack.affectedIds.membership).toBe(boMembership);
	const likes = await t.run((ctx) =>
		Promise.all(ack.affectedIds.likes.map((id) => ctx.db.get("likes", id))),
	);
	expect(likes.map((like) => [like?.message, like?.user])).toEqual([
		[a1, bo],
		[a2, cy],
		[a1, cy],
	]);
	// One transaction bumps the marker once.
	const next = await t.mutation(setMembershipActive, { membership: boMembership, active: true });
	expect(next.marker).toBe(ack.marker + 1);
});

test("more than 50 messages select the latest 50 in canonical descending order", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo } = await seedRoom(t);
	const sent: Id<"messages">[] = [];
	for (let i = 0; i < 55; i++) {
		sent.push(await send(t, room, i % 2 === 0 ? ada : bo, `m${i}`));
	}

	const feed = await t.query(roomFeed, { room });
	expect(feed.map((row) => row._id)).toEqual([...sent].reverse().slice(0, 50));
	// Canonical order is descending [_creationTime, _id], checked directly
	// on the rows rather than normalized for display.
	for (let i = 1; i < feed.length; i++) {
		const prev = feed[i - 1]!;
		const cur = feed[i]!;
		const descending =
			prev._creationTime > cur._creationTime ||
			(prev._creationTime === cur._creationTime && prev._id > cur._id);
		expect(descending).toBe(true);
	}
	// The Skip side of this comparison belongs to U6, through Q's
	// comparator; convex-test cannot force the exact-tie case (V4 and the
	// U11 reference run prove it).
});

test("likeCount reflects add, remove, message delete, and missing liked-user cases", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo, cy } = await seedRoom(t);
	const a1 = await send(t, room, ada, "a1");
	const a2 = await send(t, room, ada, "a2");

	await t.mutation(addLike, { message: a1, user: bo });
	const cyLike = (await t.mutation(addLike, { message: a1, user: cy })).affectedIds.like;
	await t.mutation(addLike, { message: a2, user: bo });
	expect(await feedSummary(t, room)).toEqual([
		["a2", "Ada", 1],
		["a1", "Ada", 2],
	]);

	// A like whose user no longer exists still counts.
	await t.mutation(deleteUser, { user: bo });
	expect(await feedSummary(t, room)).toEqual([
		["a2", "Ada", 1],
		["a1", "Ada", 2],
	]);

	await t.mutation(removeLike, { like: cyLike });
	expect(await feedSummary(t, room)).toEqual([
		["a2", "Ada", 1],
		["a1", "Ada", 1],
	]);

	// Deleting a liked message drops it, and its likes with it, from the feed.
	await t.mutation(deleteMessage, { message: a2 });
	expect(await feedSummary(t, room)).toEqual([["a1", "Ada", 1]]);
});

test("the all-selected-rows baseline contains every selected row and grows with N, unlike the bounded oracle", async () => {
	const sizes = [];
	for (const n of [10, 40, 160]) {
		const t = convexTest(schema, modules);
		const { room, ada, bo, cy } = await seedRoom(t);
		const expectedIds = new Set<string>([room, ada, bo, cy]);
		for (let i = 0; i < n; i++) {
			const message = await send(t, room, i % 2 === 0 ? ada : bo, `m${i}`);
			expectedIds.add(message);
			expectedIds.add((await t.mutation(addLike, { message, user: cy })).affectedIds.like);
		}
		const rows = await t.query(allSelectedRows, {});
		const ids = new Set(rows.map((row) => row.doc._id));
		for (const id of expectedIds) expect(ids.has(id)).toBe(true);
		for (const table of ["rooms", "users", "memberships", "messages", "likes", "marker"]) {
			expect(rows.some((row) => row.table === table)).toBe(true);
		}
		sizes.push({ n, baseline: rows.length, oracle: (await t.query(roomFeed, { room })).length });
	}
	// 1 room + 3 users + 2 memberships + 1 marker, plus a message and a
	// like per step: the baseline is exactly 7 + 2N, while the oracle
	// stays capped at 50.
	expect(sizes).toEqual([
		{ n: 10, baseline: 27, oracle: 10 },
		{ n: 40, baseline: 87, oracle: 40 },
		{ n: 160, baseline: 327, oracle: 50 },
	]);
});

test("replaying a batch leaves the feed unchanged", async () => {
	const t = convexTest(schema, modules);
	const { room, ada, bo, boMembership } = await seedRoom(t);
	const a1 = await send(t, room, ada, "a1");

	const args = {
		membership: boMembership,
		active: true,
		likes: [{ message: a1, user: bo }],
	};
	await t.mutation(membershipAndLikesBatchTxn, args);
	const before = await feedSummary(t, room);
	const replay = await t.mutation(membershipAndLikesBatchTxn, args);

	expect(await feedSummary(t, room)).toEqual(before);
	expect(before).toEqual([["a1", "Ada", 1]]);
	// The replay names the same like row instead of adding one.
	expect(replay.affectedIds.likes).toHaveLength(1);
});
