import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import schema from "./schema";

export const sendMessage = mutation({
	args: {
		user: v.id("users"),
		body: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.insert("messages", {
			user: args.user,
			body: args.body,
		});
	},
});


export const getMessages = query({
	args: {},
	returns: v.array(schema.doc("messages").extend({ name: v.string() })),
	handler: async (ctx) => {
		// Get most recent messages first
		const messages = await ctx.db.query("messages").order("desc").take(50);

		const uniqueUserIds = [...new Set(messages.map((message) => message.user))];
		const users = await Promise.all(uniqueUserIds.map((userId) => ctx.db.get("users", userId)));
		const nameByUserId = new Map(
			users.map((user, i) => [uniqueUserIds[i], user?.name ?? "Unknown"]),
		);

		// Reverse the list so that it's in a chronological order.
		return messages.reverse().map((message) => ({
			...message,
			name: nameByUserId.get(message.user) ?? "Unknown",
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
