/**
 * The shared proof-vehicle contract's canonical feed and bounded indexed
 * baseline (docs/plans/2026-09-11-1159-feat-skip-shared-prerequisites-plan.md,
 * U4). This module is intentionally independent of `@skip-adapter/atomic-batch`
 * (KTD3: Q13 has no compile-time dependency on the `skip` workspace).
 */

import { query, type QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";

const feedRow = v.object({
	_id: v.id("messages"),
	_creationTime: v.number(),
	room: v.id("rooms"),
	body: v.string(),
	sender: v.union(v.null(), v.object({ _id: v.id("users"), name: v.string() })),
	likeCount: v.number(),
});

/** Descending `[_creationTime, _id]`, the contract's canonical order. */
function compareDesc(a: Doc<"messages">, b: Doc<"messages">): number {
	if (a._creationTime !== b._creationTime) {
		return b._creationTime - a._creationTime;
	}
	if (a._id === b._id) return 0;
	return a._id > b._id ? -1 : 1;
}

async function isActiveMember(
	ctx: QueryCtx,
	room: Id<"rooms">,
	user: Id<"users">,
): Promise<boolean> {
	// by_room_user has no uniqueness guarantee, so a caller that races two
	// membership inserts for the same (room, user) must not make this throw;
	// treat the pair as active if any matching row is active.
	const memberships = await ctx.db
		.query("memberships")
		.withIndex("by_room_user", (q) => q.eq("room", room).eq("user", user))
		.collect();
	return memberships.some((membership) => membership.active);
}

// Oracle-only: `.collect().length` is fine for the canonical exact-answer
// feed, but do not copy this into a production like-count query — maintain
// a denormalized counter or use the aggregate component instead.
async function likeCountFor(ctx: QueryCtx, message: Id<"messages">): Promise<number> {
	const likes = await ctx.db
		.query("likes")
		.withIndex("by_message", (q) => q.eq("message", message))
		.collect();
	return likes.length;
}

async function toFeedRow(ctx: QueryCtx, message: Doc<"messages">) {
	const [senderDoc, likeCount] = await Promise.all([
		ctx.db.get("users", message.sender),
		likeCountFor(ctx, message._id),
	]);
	const sender = senderDoc === null ? null : { _id: senderDoc._id, name: senderDoc.name };
	return {
		_id: message._id,
		_creationTime: message._creationTime,
		room: message.room,
		body: message.body,
		sender,
		likeCount,
	};
}

/**
 * Selects only messages in `room` whose sender has an active matching
 * membership, filters and sorts explicitly (a missing/inactive membership
 * excludes the message; the `_id` tie-break must hold even though Convex's
 * own `.order("desc")` does not promise one), and returns the top `limit`
 * rows. Shared by the canonical oracle (`roomFeed`, `limit: 50`) and the
 * bounded indexed baseline (`roomFeedPrefix`).
 */
async function boundedRoomFeed(ctx: QueryCtx, room: Id<"rooms">, limit: number) {
	const candidates = await ctx.db
		.query("messages")
		.withIndex("by_room", (q) => q.eq("room", room))
		.collect();

	const flags = await Promise.all(
		candidates.map((message) => isActiveMember(ctx, room, message.sender)),
	);
	const included: Doc<"messages">[] = [];
	candidates.forEach((message, i) => {
		if (flags[i]) {
			included.push(message);
		}
	});
	included.sort(compareDesc);
	return Promise.all(included.slice(0, limit).map((message) => toFeedRow(ctx, message)));
}

/** The canonical oracle: the fixed 50-message room feed (P6, Q4). */
export const roomFeed = query({
	args: { room: v.id("rooms") },
	returns: v.array(feedRow),
	handler: async (ctx, args) => boundedRoomFeed(ctx, args.room, 50),
});

/**
 * The bounded indexed baseline (1b R13): the same canonical predicate,
 * order, and projection as `roomFeed`, taking an explicit prefix length
 * instead of the fixed 50. Never paginates above the observable-query
 * boundary `roomFeed` itself uses.
 */
export const roomFeedPrefix = query({
	args: { room: v.id("rooms"), n: v.number() },
	returns: v.array(feedRow),
	handler: async (ctx, args) => {
		if (!Number.isInteger(args.n) || args.n < 0 || args.n > 50) {
			throw new Error("roomFeedPrefix: n must be an integer in [0, 50]");
		}
		return boundedRoomFeed(ctx, args.room, args.n);
	},
});
