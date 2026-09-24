import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The shared Skip/Convex proof-vehicle contract (docs/plans/
// 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md): rooms, users,
// memberships, messages, and likes, plus the required application indexes
// (memberships.by_room_user, messages.by_room, messages.by_sender,
// likes.by_message). `rooms.by_name` and `users.by_name` are local
// lookup indexes, not part of the shared contract.
export default defineSchema({
	rooms: defineTable({ name: v.string() }).index("by_name", ["name"]),
	users: defineTable({ name: v.string() }).index("by_name", ["name"]),
	memberships: defineTable({
		room: v.id("rooms"),
		user: v.id("users"),
		active: v.boolean(),
	}).index("by_room_user", ["room", "user"]),
	messages: defineTable({
		room: v.id("rooms"),
		sender: v.id("users"),
		body: v.string(),
	})
		.index("by_room", ["room"])
		.index("by_sender", ["sender"]),
	likes: defineTable({
		message: v.id("messages"),
		user: v.id("users"),
	}).index("by_message", ["message"]),
	// Harness-only: outside the five-table proof vehicle. One row holding a
	// sequence number a separate-session source can subscribe to as a
	// gate-1 marker (KTD4). Populated by proofVehicle/fixture:marker.
	proofVehicleMarkers: defineTable({ sequence: v.number() }),
});
