import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import schema from "./schema";

// KTD8: messages moved from {user, body} to {room, sender, body}.
// sendMessage lazily creates this default room so the client's
// {user, body} call shape (src/App.tsx) needs no change.
const DEFAULT_ROOM_NAME = "general";

/**
 * by_name has no uniqueness guarantee, so two racing sendMessage calls that
 * both see no room and both insert must not make a later lookup throw;
 * take the oldest matching row (the one actually chosen by the first
 * insert to win) instead of asserting exactly one exists. Shared by
 * getOrCreateDefaultRoom and getMessages (branch-review BR6: previously
 * written twice, once as insert-if-missing and once read-only).
 */
async function findDefaultRoom(ctx: QueryCtx): Promise<Doc<"rooms"> | undefined> {
	const [existing] = await ctx.db
		.query("rooms")
		.withIndex("by_name", (q) => q.eq("name", DEFAULT_ROOM_NAME))
		.order("asc")
		.take(1);
	return existing;
}

async function getOrCreateDefaultRoom(ctx: MutationCtx): Promise<Id<"rooms">> {
	const existing = await findDefaultRoom(ctx);
	if (existing !== undefined) {
		return existing._id;
	}
	return await ctx.db.insert("rooms", { name: DEFAULT_ROOM_NAME });
}

export const sendMessage = mutation({
	args: {
		user: v.id("users"),
		body: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const room = await getOrCreateDefaultRoom(ctx);
		await ctx.db.insert("messages", {
			room,
			sender: args.user,
			body: args.body,
		});
	},
});

export const getMessages = query({
	args: {},
	returns: v.array(
		schema.doc("messages").extend({ user: v.id("users"), name: v.string() }),
	),
	handler: async (ctx) => {
		// getMessages is a query and cannot insert, so it returns [] before
		// the default room exists (i.e. before any message has been sent).
		const room = await findDefaultRoom(ctx);
		if (room === undefined) {
			return [];
		}

		// Get most recent messages first
		const messages = await ctx.db
			.query("messages")
			.withIndex("by_room", (q) => q.eq("room", room._id))
			.order("desc")
			.take(50);

		const uniqueSenderIds = [...new Set(messages.map((message) => message.sender))];
		const senders = await Promise.all(
			uniqueSenderIds.map((senderId) => ctx.db.get("users", senderId)),
		);
		const nameBySenderId = new Map(
			senders.map((sender, i) => [uniqueSenderIds[i], sender?.name ?? "Unknown"]),
		);

		// Reverse the list so that it's in a chronological order.
		return messages.reverse().map((message) => ({
			...message,
			// `user` aliases `sender` so existing clients (src/App.tsx) need no change.
			user: message.sender,
			name: nameBySenderId.get(message.sender) ?? "Unknown",
		}));
	},
});

export const getOrCreateUser = mutation({
	args: { name: v.string() },
	returns: v.id("users"),
	handler: async (ctx, args) => {
		// by_name is a plain (non-unique) index: two racing calls can both
		// see no row and both insert, so resolve the oldest match instead
		// of asserting exactly one exists.
		const [existing] = await ctx.db
			.query("users")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.order("asc")
			.take(1);
		if (existing !== undefined) {
			return existing._id;
		}
		return await ctx.db.insert("users", { name: args.name });
	},
});
