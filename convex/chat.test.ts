/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Branch-review BR3: getMessages's `if (room === null) return []` guard
// (the case before any message has ever been sent, on a genuinely fresh
// deployment) was never exercised by any prior test -- every other case
// calls sendMessage first, which lazily creates the room.
test("getMessages returns [] on a fresh deployment, before any room exists", async () => {
	const t = convexTest(schema, modules);
	const messages = await t.query(api.chat.getMessages, {});
	expect(messages).toEqual([]);
});

test("getOrCreateUser is idempotent and distinguishes different names", async () => {
	const t = convexTest(schema, modules);

	const aliceId1 = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });
	const aliceId2 = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });
	expect(aliceId2).toBe(aliceId1);

	const bobId = await t.mutation(api.chat.getOrCreateUser, { name: "Bob" });
	expect(bobId).not.toBe(aliceId1);

	const users = await t.run((ctx) => ctx.db.query("users").collect());
	expect(users.filter((user) => user.name === "Alice")).toHaveLength(1);
});

// Two racing getOrCreateUser calls can both see no row and both insert;
// the lookup must resolve instead of throwing on the duplicate.
test("getOrCreateUser tolerates duplicate names instead of throwing", async () => {
	const t = convexTest(schema, modules);
	const first = await t.run((ctx) => ctx.db.insert("users", { name: "Dup" }));
	await t.run((ctx) => ctx.db.insert("users", { name: "Dup" }));
	const resolved = await t.mutation(api.chat.getOrCreateUser, { name: "Dup" });
	expect(resolved).toBe(first);
});

test("sendMessage inserts a message tied to the given user", async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });

	await t.mutation(api.chat.sendMessage, { user: userId, body: "hi" });

	const messages = await t.run((ctx) => ctx.db.query("messages").collect());
	expect(messages).toHaveLength(1);
	expect(messages[0].sender).toBe(userId);
	expect(messages[0].body).toBe("hi");
});

test("getMessages resolves each message's sender name and returns chronological order", async () => {
	const t = convexTest(schema, modules);
	const aliceId = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });
	const bobId = await t.mutation(api.chat.getOrCreateUser, { name: "Bob" });

	await t.mutation(api.chat.sendMessage, { user: aliceId, body: "first" });
	await t.mutation(api.chat.sendMessage, { user: bobId, body: "second" });

	const messages = await t.query(api.chat.getMessages, {});
	expect(messages.map((message) => message.body)).toEqual(["first", "second"]);
	expect(messages[0].name).toBe("Alice");
	expect(messages[1].name).toBe("Bob");

	// The id is what identifies "mine", not the resolved display name.
	expect(messages[0].user).toBe(aliceId);
	expect(messages[0].name).not.toBe(messages[0].user);
});

test('getMessages falls back to "Unknown" when a message\'s user no longer resolves', async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Ghost" });
	await t.mutation(api.chat.sendMessage, { user: userId, body: "boo" });
	await t.run((ctx) => ctx.db.delete("users", userId));

	const messages = await t.query(api.chat.getMessages, {});
	expect(messages).toHaveLength(1);
	expect(messages[0].name).toBe("Unknown");
});

test("sendMessage throws on a dangling sender id without writing anything", async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Ghost" });
	await t.run((ctx) => ctx.db.delete("users", userId));

	await expect(t.mutation(api.chat.sendMessage, { user: userId, body: "boo" })).rejects.toThrow(
		/does not exist/,
	);
	const stored = await t.run(async (ctx) => ({
		rooms: await ctx.db.query("rooms").collect(),
		memberships: await ctx.db.query("memberships").collect(),
		messages: await ctx.db.query("messages").collect(),
	}));
	expect(stored.rooms).toHaveLength(0);
	expect(stored.memberships).toHaveLength(0);
	expect(stored.messages).toHaveLength(0);
});

test("sendMessage reactivates a deactivated membership instead of duplicating it", async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });
	await t.mutation(api.chat.sendMessage, { user: userId, body: "first" });
	await t.run(async (ctx) => {
		const [membership] = await ctx.db.query("memberships").collect();
		await ctx.db.patch("memberships", membership!._id, { active: false });
	});

	await t.mutation(api.chat.sendMessage, { user: userId, body: "second" });

	const memberships = await t.run((ctx) => ctx.db.query("memberships").collect());
	const messages = await t.query(api.chat.getMessages, {});
	expect(memberships).toHaveLength(1);
	expect(memberships[0]?.active).toBe(true);
	expect(messages.map((message) => message.body)).toEqual(["first", "second"]);
});

test("getMessages returns only default-room messages, newest 50", async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });
	await t.mutation(api.chat.sendMessage, { user: userId, body: "home" });
	const otherRoom = await t.run((ctx) => ctx.db.insert("rooms", { name: "other" }));
	await t.run((ctx) => ctx.db.insert("messages", { room: otherRoom, sender: userId, body: "away" }));
	for (let i = 0; i < 50; i++) {
		await t.mutation(api.chat.sendMessage, { user: userId, body: `m${i}` });
	}

	const messages = await t.query(api.chat.getMessages, {});
	expect(messages).toHaveLength(50);
	expect(messages.some((message) => message.body === "away")).toBe(false);
	expect(messages.some((message) => message.body === "home")).toBe(false);
	expect(messages[0]?.body).toBe("m0");
	expect(messages.at(-1)?.body).toBe("m49");
});
