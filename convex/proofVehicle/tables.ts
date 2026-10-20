import { query } from "../_generated/server";
import { v } from "convex/values";
import schema from "../schema";
import { pickMarkerRow } from "./fixture";

export const rooms = query({
	args: {},
	returns: v.array(schema.doc("rooms")),
	handler: async (ctx) => ctx.db.query("rooms").collect(),
});

export const users = query({
	args: {},
	returns: v.array(schema.doc("users")),
	handler: async (ctx) => ctx.db.query("users").collect(),
});

export const memberships = query({
	args: {},
	returns: v.array(schema.doc("memberships")),
	handler: async (ctx) => ctx.db.query("memberships").collect(),
});

export const messages = query({
	args: {},
	returns: v.array(schema.doc("messages")),
	handler: async (ctx) => ctx.db.query("messages").collect(),
});

export const likes = query({
	args: {},
	returns: v.array(schema.doc("likes")),
	handler: async (ctx) => ctx.db.query("likes").collect(),
});

/**
 * The harness-only marker sequence row (KTD4), for separate-session
 * sources that cannot read a mutation's own commit timestamp. `null`
 * before `proofVehicle/fixture:marker` first runs. Resolves "latest" with
 * the shared `pickMarkerRow` (highest sequence) so a leftover/double-run
 * duplicate degrades to the same row `bumpMarker` would advance instead
 * of throwing. The markers table holds one row in practice; the collect
 * below scans at most the leftover duplicates.
 */
export const markers = query({
	args: {},
	returns: v.union(v.null(), schema.doc("proofVehicleMarkers")),
	handler: async (ctx) => {
		const rows = await ctx.db.query("proofVehicleMarkers").collect();
		return pickMarkerRow(rows) ?? null;
	},
});

const taggedRow = v.union(
	v.object({ table: v.literal("rooms"), doc: schema.doc("rooms") }),
	v.object({ table: v.literal("users"), doc: schema.doc("users") }),
	v.object({ table: v.literal("memberships"), doc: schema.doc("memberships") }),
	v.object({ table: v.literal("messages"), doc: schema.doc("messages") }),
	v.object({ table: v.literal("likes"), doc: schema.doc("likes") }),
	v.object({ table: v.literal("marker"), doc: schema.doc("proofVehicleMarkers") }),
);

/**
 * The monolithic baseline (1c KTD11) and Q9's source query: every row
 * across the five-table proof vehicle plus the harness-only marker row,
 * each tagged with its table name (the `WorkspaceRow` tagged-union
 * convention `examples/convex_reactive/shared/model.ts:16-18` uses).
 */
export const allSelectedRows = query({
	args: {},
	returns: v.array(taggedRow),
	handler: async (ctx) => {
		const [roomRows, userRows, membershipRows, messageRows, likeRows, markerRows] =
			await Promise.all([
				ctx.db.query("rooms").collect(),
				ctx.db.query("users").collect(),
				ctx.db.query("memberships").collect(),
				ctx.db.query("messages").collect(),
				ctx.db.query("likes").collect(),
				ctx.db.query("proofVehicleMarkers").collect(),
			]);
		return [
			...roomRows.map((doc) => ({ table: "rooms" as const, doc })),
			...userRows.map((doc) => ({ table: "users" as const, doc })),
			...membershipRows.map((doc) => ({ table: "memberships" as const, doc })),
			...messageRows.map((doc) => ({ table: "messages" as const, doc })),
			...likeRows.map((doc) => ({ table: "likes" as const, doc })),
			...markerRows.map((doc) => ({ table: "marker" as const, doc })),
		];
	},
});
