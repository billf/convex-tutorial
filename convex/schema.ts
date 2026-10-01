import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// messages: one index for looking up by sender.
// users: one index for looking up by name.
export default defineSchema({
	messages: defineTable({
		user: v.id("users"),
		body: v.string(),
	})
		.index("by_user", ["user"]),
	users: defineTable({ name: v.string() }).index("by_name", ["name"]),
});
