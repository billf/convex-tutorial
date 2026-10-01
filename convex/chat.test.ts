/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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

test("sendMessage inserts a message tied to the given user", async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });

	await t.mutation(api.chat.sendMessage, { user: userId, body: "hi" });

	const messages = await t.run((ctx) => ctx.db.query("messages").collect());
	expect(messages).toHaveLength(1);
	expect(messages[0].user).toBe(userId);
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
