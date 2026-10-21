/// <reference types="vite/client" />
/**
 * Mutation unit tests for the proof-vehicle harness: single mutations,
 * the batch txn, ack shape, and the delta-harness registry itself.
 * Corpus vectors live in proofVehicle.test.ts; parity goldens in
 * proofVehicle.parity.test.ts; shared loading/binding helpers in
 * ./testHelpers.
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import corpus from "./corpus/v1.json";
import type { BaseOp } from "./fixture";
import {
	MUTATIONS,
	MUTATION_TEST_META,
	runLoadBase,
	seedRoomWithMember,
	fixtureMarker,
	fixtureReset,
	patchMessageBody,
} from "./testHelpers";

const modules = import.meta.glob("/convex/**/*.ts");
test("MUTATION_TEST_META covers exactly the registered MUTATIONS", () => {
	expect(new Set(Object.keys(MUTATION_TEST_META))).toEqual(new Set(Object.keys(MUTATIONS)));
});

// Every MUTATION_TEST_META `bindKey` names a key its mutation's ack
// actually returns, holding the row the mutation wrote: the key-set parity
// test above cannot catch a mistyped value or a right-key/wrong-id ack (the
// M5 class), so each mutation runs once against real rows, the bound key is
// asserted present, and the bound id is asserted to name the written row.
// Deletes run last against dedicated targets with decoys left behind, so a
// wrong-row delete is caught by the surviving decoy.
test("every MUTATION_TEST_META bindKey is present in its mutation's ack and names the written row", async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const room = await ctx.db.insert("rooms", { name: "r" });
		const user = await ctx.db.insert("users", { name: "u" });
		const decoyUser = await ctx.db.insert("users", { name: "w" });
		const membership = await ctx.db.insert("memberships", { room, user, active: true });
		const message = await ctx.db.insert("messages", { room, sender: user, body: "m" });
		const decoyLike = await ctx.db.insert("likes", { message, user: decoyUser });
		return { room, user, decoyUser, membership, message, decoyLike };
	});
	const messages = () => t.run((ctx) => ctx.db.query("messages").collect());
	const likes = () => t.run((ctx) => ctx.db.query("likes").collect());
	const check = (name: string, affectedIds: Record<string, string>) => {
		const bindKey = MUTATION_TEST_META[name]?.bindKey;
		expect(bindKey, `${name} has a bindKey`).toBeDefined();
		expect(affectedIds[bindKey!], `${name} ack names ${bindKey}`).toBeDefined();
	};

	const sendAck = await t.mutation(MUTATIONS["sendMessage"]!, {
		room: ids.room,
		sender: ids.user,
		body: "n",
	});
	check("sendMessage", sendAck.affectedIds);
	expect((await messages()).find((m) => m.body === "n")!._id).toBe(sendAck.affectedIds["message"]);
	await t.mutation(MUTATIONS["updateMessageBody"]!, {
		message: sendAck.affectedIds["message"],
		body: "n2",
	});
	expect((await messages()).find((m) => m.body === "n2")!._id).toBe(sendAck.affectedIds["message"]);

	const addAck = await t.mutation(MUTATIONS["addLike"]!, { message: ids.message, user: ids.user });
	check("addLike", addAck.affectedIds);
	expect(
		(await likes()).find((l) => l.message === ids.message && l.user === ids.user)!._id,
	).toBe(addAck.affectedIds["like"]);
	check("removeLike", (await t.mutation(MUTATIONS["removeLike"]!, { like: addAck.affectedIds["like"] })).affectedIds);
	expect((await likes()).some((l) => l.message === ids.message && l.user === ids.user)).toBe(false);
	expect((await likes()).some((l) => l._id === ids.decoyLike)).toBe(true);

	check(
		"setMembershipActive",
		(await t.mutation(MUTATIONS["setMembershipActive"]!, { membership: ids.membership, active: false }))
			.affectedIds,
	);
	expect((await t.run((ctx) => ctx.db.get("memberships", ids.membership)))?.active).toBe(false);
	const txnAck = await t.mutation(MUTATIONS["membershipAndLikesTxn"]!, {
		membership: ids.membership,
		active: true,
		message: ids.message,
		user: ids.user,
	});
	check("membershipAndLikesTxn", txnAck.affectedIds);
	expect(
		(await likes()).find((l) => l.message === ids.message && l.user === ids.user)!._id,
	).toBe(txnAck.affectedIds["like"]);
	const batchAck = await t.mutation(MUTATIONS["membershipAndLikesBatchTxn"]!, {
		membership: ids.membership,
		active: true,
		likes: [{ message: ids.message, user: ids.user }],
	});
	check("membershipAndLikesBatchTxn", batchAck.affectedIds);
	expect(batchAck.affectedIds["membership"]).toBe(ids.membership);
	expect((await likes()).some((l) => l.message === ids.message && l.user === ids.user)).toBe(true);

	check(
		"deleteMessage",
		(await t.mutation(MUTATIONS["deleteMessage"]!, { message: sendAck.affectedIds["message"] }))
			.affectedIds,
	);
	expect((await messages()).some((m) => m.body === "n2")).toBe(false);
	expect((await messages()).some((m) => m._id === ids.message)).toBe(true);
	check("renameUser", (await t.mutation(MUTATIONS["renameUser"]!, { user: ids.user, name: "v" })).affectedIds);
	expect((await t.run((ctx) => ctx.db.get("users", ids.user)))?.name).toBe("v");
	check("deleteUser", (await t.mutation(MUTATIONS["deleteUser"]!, { user: ids.user })).affectedIds);
	expect(await t.run((ctx) => ctx.db.get("users", ids.user))).toBe(null);
	expect(await t.run((ctx) => ctx.db.get("users", ids.decoyUser))).not.toBe(null);
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

test("membershipAndLikesBatchTxn rejects 101 likes without writing", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const message = await t.run((ctx) =>
		ctx.db.insert("messages", { room, sender: user, body: "hello" }),
	);
	const { marker } = await t.mutation(fixtureMarker, {});

	await expect(
		t.mutation(membershipAndLikesBatchTxn, {
			membership,
			active: false,
			likes: Array.from({ length: 101 }, () => ({ message, user })),
		}),
	).rejects.toThrow(/1 to 100/);

	const stored = await t.run(async (ctx) => ({
		membership: await ctx.db.get("memberships", membership),
		likes: await ctx.db.query("likes").take(1),
		marker: await ctx.db.query("proofVehicleMarkers").unique(),
	}));
	expect(stored.membership?.active).toBe(true);
	expect(stored.likes).toHaveLength(0);
	expect(stored.marker?.sequence).toBe(marker);
});

test("membershipAndLikesBatchTxn is idempotent: replaying a batch names the same like rows", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const { m1, liker } = await t.run(async (ctx) => ({
		m1: await ctx.db.insert("messages", { room, sender: user, body: "one" }),
		liker: await ctx.db.insert("users", { name: "Liker" }),
	}));
	const args = { membership, active: false, likes: [{ message: m1, user: liker }] };

	const first = await t.mutation(membershipAndLikesBatchTxn, args);
	const second = await t.mutation(membershipAndLikesBatchTxn, args);
	expect(second.affectedIds.likes).toEqual(first.affectedIds.likes);

	const likes = await t.run((ctx) => ctx.db.query("likes").collect());
	expect(likes).toHaveLength(1);
	// A replayed batch still runs the mutation, so the marker advances.
	expect(second.marker).toBe(first.marker + 1);
});

test("membershipAndLikesBatchTxn collapses duplicate pairs within one batch", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const { m1, liker } = await t.run(async (ctx) => ({
		m1: await ctx.db.insert("messages", { room, sender: user, body: "one" }),
		liker: await ctx.db.insert("users", { name: "Liker" }),
	}));

	const ack = await t.mutation(membershipAndLikesBatchTxn, {
		membership,
		active: false,
		likes: [
			{ message: m1, user: liker },
			{ message: m1, user: liker },
		],
	});
	expect(ack.affectedIds.likes).toHaveLength(2);
	expect(ack.affectedIds.likes[0]).toBe(ack.affectedIds.likes[1]);

	const likes = await t.run((ctx) => ctx.db.query("likes").collect());
	expect(likes).toHaveLength(1);
});

test("membershipAndLikesBatchTxn skips likes whose message or user no longer exists", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const { m1, liker, deadMessage, deadUser } = await t.run(async (ctx) => ({
		m1: await ctx.db.insert("messages", { room, sender: user, body: "one" }),
		liker: await ctx.db.insert("users", { name: "Liker" }),
		deadMessage: await ctx.db.insert("messages", { room, sender: user, body: "gone" }),
		deadUser: await ctx.db.insert("users", { name: "Ghost" }),
	}));
	await t.run(async (ctx) => {
		await ctx.db.delete("messages", deadMessage);
		await ctx.db.delete("users", deadUser);
	});

	const ack = await t.mutation(membershipAndLikesBatchTxn, {
		membership,
		active: false,
		likes: [
			{ message: m1, user: liker },
			{ message: deadMessage, user: liker },
			{ message: m1, user: deadUser },
		],
	});
	// Only the live pair is acked, in request order; nothing is resurrected.
	expect(ack.affectedIds.likes).toHaveLength(1);

	const stored = await t.run(async (ctx) => ({
		membership: await ctx.db.get("memberships", membership),
		likes: await ctx.db.query("likes").collect(),
		users: await ctx.db.query("users").collect(),
		messages: await ctx.db.query("messages").collect(),
	}));
	expect(stored.membership?.active).toBe(false);
	expect(stored.likes.map((like) => [like?.message, like?.user])).toEqual([[m1, liker]]);
	expect(stored.users.some((u) => u.name === "Ghost")).toBe(false);
	expect(stored.messages.some((m) => m.body === "gone")).toBe(false);
});

test("membershipAndLikesBatchTxn with only dangling entries still patches the membership", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const deadMessage = await t.run(async (ctx) => {
		const m = await ctx.db.insert("messages", { room, sender: user, body: "gone" });
		return m;
	});
	await t.run((ctx) => ctx.db.delete("messages", deadMessage));
	const { marker } = await t.mutation(fixtureMarker, {});

	const ack = await t.mutation(membershipAndLikesBatchTxn, {
		membership,
		active: false,
		likes: [{ message: deadMessage, user }],
	});
	expect(ack.affectedIds.likes).toEqual([]);

	const stored = await t.run(async (ctx) => ({
		membership: await ctx.db.get("memberships", membership),
		likes: await ctx.db.query("likes").collect(),
		marker: await ctx.db.query("proofVehicleMarkers").unique(),
	}));
	expect(stored.membership?.active).toBe(false);
	expect(stored.likes).toHaveLength(0);
	expect(stored.marker?.sequence).toBe(marker + 1);
});

test("membershipAndLikesBatchTxn rejects a batch spanning two rooms without writing", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const other = await t.run(async (ctx) => {
		const otherRoom = await ctx.db.insert("rooms", { name: "other" });
		const m2 = await ctx.db.insert("messages", { room: otherRoom, sender: user, body: "far" });
		return { m2 };
	});
	const { marker } = await t.mutation(fixtureMarker, {});

	await expect(
		t.mutation(membershipAndLikesBatchTxn, {
			membership,
			active: false,
			likes: [{ message: other.m2, user }],
		}),
	).rejects.toThrow(/membership's room/);

	const stored = await t.run(async (ctx) => ({
		membership: await ctx.db.get("memberships", membership),
		likes: await ctx.db.query("likes").collect(),
		marker: await ctx.db.query("proofVehicleMarkers").unique(),
	}));
	expect(stored.membership?.active).toBe(true);
	expect(stored.likes).toHaveLength(0);
	expect(stored.marker?.sequence).toBe(marker);
});

test("membershipAndLikesBatchTxn rejects an unknown membership without writing", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	const doomedMembership = await t.run(async (ctx) => {
		const id = await ctx.db.insert("memberships", { room, user, active: true });
		return id;
	});
	await t.run((ctx) => ctx.db.delete("memberships", doomedMembership));
	const message = await t.run((ctx) =>
		ctx.db.insert("messages", { room, sender: user, body: "hello" }),
	);
	const { marker } = await t.mutation(fixtureMarker, {});

	await expect(
		t.mutation(membershipAndLikesBatchTxn, {
			membership: doomedMembership,
			active: false,
			likes: [{ message, user }],
		}),
	).rejects.toThrow(/does not exist/);

	const stored = await t.run(async (ctx) => ({
		likes: await ctx.db.query("likes").collect(),
		marker: await ctx.db.query("proofVehicleMarkers").unique(),
	}));
	expect(stored.likes).toHaveLength(0);
	expect(stored.marker?.sequence).toBe(marker);
});
test("addLike is idempotent and refuses dangling targets", async () => {
	const t = convexTest(schema, modules);
	const { room, user } = await seedRoomWithMember(t);
	const { m1, liker } = await t.run(async (ctx) => ({
		m1: await ctx.db.insert("messages", { room, sender: user, body: "one" }),
		liker: await ctx.db.insert("users", { name: "Liker" }),
	}));

	const first = await t.mutation(MUTATIONS.addLike!, { message: m1, user: liker });
	const second = await t.mutation(MUTATIONS.addLike!, { message: m1, user: liker });
	expect(second.affectedIds["like"]).toBe(first.affectedIds["like"]);
	const likes = await t.run((ctx) => ctx.db.query("likes").collect());
	expect(likes).toHaveLength(1);

	await t.run((ctx) => ctx.db.delete("messages", m1));
	await expect(t.mutation(MUTATIONS.addLike!, { message: m1, user: liker })).rejects.toThrow(
		/must both exist/,
	);
});

test("membershipAndLikesTxn is idempotent on a repeated like", async () => {
	const t = convexTest(schema, modules);
	const { room, user, membership } = await seedRoomWithMember(t);
	const { m1, liker } = await t.run(async (ctx) => ({
		m1: await ctx.db.insert("messages", { room, sender: user, body: "one" }),
		liker: await ctx.db.insert("users", { name: "Liker" }),
	}));

	const args = { membership, active: false, message: m1, user: liker };
	const first = await t.mutation(MUTATIONS.membershipAndLikesTxn!, args);
	const second = await t.mutation(MUTATIONS.membershipAndLikesTxn!, args);
	expect(second.affectedIds["like"]).toBe(first.affectedIds["like"]);
	const likes = await t.run((ctx) => ctx.db.query("likes").collect());
	expect(likes).toHaveLength(1);
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
