import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

// KTD8: messages moved from {user, body} to {room, sender, body}.
// sendMessage lazily creates this default room so the client's
// {user, body} call shape (src/App.tsx) needs no change.
const DEFAULT_ROOM_NAME = "general";

async function getOrCreateDefaultRoom(ctx: MutationCtx): Promise<Id<"rooms">> {
	// by_name has no uniqueness guarantee, so two racing sendMessage calls
	// that both see no room and both insert must not make later lookups
	// throw; take the oldest matching row (the one actually chosen by the
	// first insert to win) instead of asserting exactly one exists.
	const [existing] = await ctx.db
		.query("rooms")
		.withIndex("by_name", (q) => q.eq("name", DEFAULT_ROOM_NAME))
		.order("asc")
		.take(1);
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
		// Same by_name non-uniqueness caveat as getOrCreateDefaultRoom: take
		// the oldest matching row instead of asserting exactly one exists.
		const [room] = await ctx.db
			.query("rooms")
			.withIndex("by_name", (q) => q.eq("name", DEFAULT_ROOM_NAME))
			.order("asc")
			.take(1);
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
		const existing = await ctx.db
			.query("users")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		if (existing !== null) {
			return existing._id;
		}
		return await ctx.db.insert("users", { name: args.name });
	},
});
