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
 * getOrCreateDefaultRoom and getMessages.
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
	const created = await ctx.db.insert("rooms", { name: DEFAULT_ROOM_NAME });
	// A racing first-ever sendMessage may have committed its own "general"
	// room between the lookup above and this insert (this transaction could
	// not see it). Converge on the oldest row: if it is not the one just
	// created, drop the duplicate and use the canonical one, so later reads
	// (which take the oldest match) can never miss this caller's message.
	// Residual: two commits that stay mutually invisible still leave a
	// duplicate behind -- Convex offers no uniqueness constraint to close
	// that case, so run first-ever sends quiesced if it matters.
	const canonical = await findDefaultRoom(ctx);
	if (canonical !== undefined && canonical._id !== created) {
		await ctx.db.delete("rooms", created);
		return canonical._id;
	}
	return created;
}

/**
 * Keeps demo/test chat traffic within the same
 * proof-vehicle membership model production-shaped traffic uses, rather
 * than a separate no-membership path: without this, `roomFeed` (which
 * requires an active membership) would silently exclude every message
 * sent through the live tutorial UI. Same by_room_user non-uniqueness
 * caveat as other lookups in this file: take the oldest matching row
 * instead of asserting exactly one exists, and only patch when the
 * existing row isn't already active.
 */
async function ensureActiveMembership(
	ctx: MutationCtx,
	room: Id<"rooms">,
	user: Id<"users">,
): Promise<void> {
	const [existing] = await ctx.db
		.query("memberships")
		.withIndex("by_room_user", (q) => q.eq("room", room).eq("user", user))
		.order("asc")
		.take(1);
	if (existing === undefined) {
		await ctx.db.insert("memberships", { room, user, active: true });
	} else if (!existing.active) {
		await ctx.db.patch("memberships", existing._id, { active: true });
	}
}

export const sendMessage = mutation({
	args: {
		user: v.id("users"),
		body: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Fail closed on a dangling sender (deleted user, stale tab id):
		// validate before writing anything, so a bad call creates neither
		// a room, a membership, nor a message. Matches the proof-vehicle
		// mutations' convention (addLike / membershipAndLikesTxn throw on
		// dangling targets instead of writing orphans).
		const sender = await ctx.db.get("users", args.user);
		if (sender === null) {
			throw new Error("sendMessage: user does not exist");
		}
		const room = await getOrCreateDefaultRoom(ctx);
		await ensureActiveMembership(ctx, room, args.user);
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
		// Same by_name non-uniqueness caveat as findDefaultRoom: two racing
		// calls can both see no row and both insert, so resolve the oldest
		// match instead of asserting exactly one exists.
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
