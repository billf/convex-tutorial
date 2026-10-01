import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Define a messages table with two indexes.
export default defineSchema({
	messages: defineTable({
		user: v.id("users"),
		body: v.string(),
	})
		.index("by_user", ["user"]),
	users: defineTable({ name: v.string() }).index("by_name", ["name"]),
});
