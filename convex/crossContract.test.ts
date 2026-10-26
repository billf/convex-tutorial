/**
 * Branch-review BR7/BR8: two design decisions the branch review surfaced.
 * BR8 was resolved by an explicit product decision (2026-09-26: demo/test
 * chat traffic should populate demo/test memberships, to keep demo/test
 * behavior as close to production as possible) and is now a regression
 * test for that fix. BR7 is settled as independent contracts (2026-10-26):
 * chat:getMessages keeps a dead sender id with name "Unknown" (a UI row
 * must stay displayable), while proofVehicle/feed:roomFeed projects the
 * same event as sender:null (the oracle must distinguish a missing join
 * target from a live one). Neither side may change its projection without
 * updating this contract first -- see this repo's `.agent-reviews/`
 * branch review file for the full write-up and the rejected alternatives.
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// Absolute-from-project-root glob (see proofVehicle.test.ts's own comment):
// needed because this file's sibling `proofVehicle/feed.ts` isn't in the
// generated `api` object in this checkout.
const modules = import.meta.glob("/convex/**/*.ts");

const roomFeed = makeFunctionReference<
	"query",
	{ room: Id<"rooms"> },
	{ sender: { _id: Id<"users">; name: string } | null }[]
>("proofVehicle/feed:roomFeed");

test("BR7 (settled: independent sender projections): chat keeps the dead id as Unknown while roomFeed projects sender:null", async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Ghost" });
	await t.mutation(api.chat.sendMessage, { user: userId, body: "boo" });
	// sendMessage now ensures an active membership itself (BR8, fixed below),
	// so roomFeed will include this message once the sender is deleted.
	const room = await t.run(async (ctx) => {
		const [firstRoom] = await ctx.db.query("rooms").take(1);
		return firstRoom!._id;
	});
	await t.run((ctx) => ctx.db.delete("users", userId));

	const chatMessages = await t.query(api.chat.getMessages, {});
	expect(chatMessages).toHaveLength(1);
	expect(chatMessages[0]!.name).toBe("Unknown"); // dead id kept in `user`

	const feed = await t.query(roomFeed, { room });
	expect(feed).toHaveLength(1);
	expect(feed[0]!.sender).toBe(null); // dead id dropped entirely

	// sender row no longer exists) differently on purpose (settled 2026-10-26:
	// chat keeps a displayable row, the oracle keeps join-exactness). A
	// consumer must pick its contract deliberately; changing either
	// projection requires updating the header contract first.
});

test("BR8 (fixed 2026-09-26): a message sent via chat:sendMessage is visible to proofVehicle/feed:roomFeed", async () => {
	const t = convexTest(schema, modules);
	const userId = await t.mutation(api.chat.getOrCreateUser, { name: "Alice" });
	await t.mutation(api.chat.sendMessage, { user: userId, body: "hi from the live UI" });

	const room = await t.run(async (ctx) => {
		const [firstRoom] = await ctx.db.query("rooms").take(1);
		return firstRoom!._id;
	});

	// chat:getMessages sees it (filtered only by room)...
	const chatMessages = await t.query(api.chat.getMessages, {});
	expect(chatMessages).toHaveLength(1);

	// ...and, per an explicit product decision (keep demo/test traffic as
	// close to production as possible), sendMessage now also ensures an
	// active membership, so roomFeed sees it too.
	const feed = await t.query(roomFeed, { room });
	expect(feed).toHaveLength(1);
});
