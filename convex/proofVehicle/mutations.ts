/**
 * Q13's deterministic mutations (docs/plans/
 * 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U5). Every
 * mutation returns `{affectedIds, marker}`: `affectedIds` names the rows it
 * wrote so a recorder can key on them, and `marker` (from `bumpMarker`) is
 * a harness-readable completion ack a caller can start wall-clock timers
 * from without inferring internal Convex timestamps.
 */

import { mutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { bumpMarker } from "./fixture";

export const sendMessage = mutation({
	args: { room: v.id("rooms"), sender: v.id("users"), body: v.string() },
	returns: v.object({
		affectedIds: v.object({ message: v.id("messages") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		// Fail closed like chat:sendMessage and addLike: a delta replaying
		// against a stale room or sender id must reject instead of writing
		// a phantom message that roomFeed would surface with sender: null.
		const [roomDoc, senderDoc] = await Promise.all([
			ctx.db.get("rooms", args.room),
			ctx.db.get("users", args.sender),
		]);
		if (roomDoc === null || senderDoc === null) {
			throw new Error("sendMessage: room and sender must both exist");
		}
		const message = await ctx.db.insert("messages", {
			room: args.room,
			sender: args.sender,
			body: args.body,
		});
		return { affectedIds: { message }, marker: await bumpMarker(ctx) };
	},
});

// The canonical body patch (V4's post-bind step and the general Q13 delta
// share this one registered mutation): `ctx.db.patch` never touches
// `_creationTime` (system-assigned at insert), which is exactly the
// invariant V4's tie depends on.
export const updateMessageBody = mutation({
	args: { message: v.id("messages"), body: v.string() },
	returns: v.object({
		affectedIds: v.object({ message: v.id("messages") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		await ctx.db.patch("messages", args.message, { body: args.body });
		return { affectedIds: { message: args.message }, marker: await bumpMarker(ctx) };
	},
});

export const deleteMessage = mutation({
	args: { message: v.id("messages") },
	returns: v.object({
		affectedIds: v.object({ message: v.id("messages") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		await ctx.db.delete("messages", args.message);
		return { affectedIds: { message: args.message }, marker: await bumpMarker(ctx) };
	},
});

export const renameUser = mutation({
	args: { user: v.id("users"), name: v.string() },
	returns: v.object({
		affectedIds: v.object({ user: v.id("users") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		await ctx.db.patch("users", args.user, { name: args.name });
		return { affectedIds: { user: args.user }, marker: await bumpMarker(ctx) };
	},
});

export const deleteUser = mutation({
	args: { user: v.id("users") },
	returns: v.object({
		affectedIds: v.object({ user: v.id("users") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		await ctx.db.delete("users", args.user);
		return { affectedIds: { user: args.user }, marker: await bumpMarker(ctx) };
	},
});

export const setMembershipActive = mutation({
	args: { membership: v.id("memberships"), active: v.boolean() },
	returns: v.object({
		affectedIds: v.object({ membership: v.id("memberships") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		await ctx.db.patch("memberships", args.membership, { active: args.active });
		return { affectedIds: { membership: args.membership }, marker: await bumpMarker(ctx) };
	},
});

// A like is an idempotent action: writing the same (message, user) pair
// twice names the same row instead of inserting a duplicate. Fail-closed
// on dangling targets: a like whose message or user row does not exist is
// never written, so no join ever points at a non-existent row.
async function findLike(
	ctx: MutationCtx,
	message: Id<"messages">,
	user: Id<"users">,
) {
	const likes = await ctx.db
		.query("likes")
		.withIndex("by_message", (q) => q.eq("message", message))
		.collect();
	return likes.find((like) => like.user === user) ?? null;
}

async function likeTargetsExist(
	ctx: MutationCtx,
	message: Id<"messages">,
	user: Id<"users">,
) {
	const [messageDoc, userDoc] = await Promise.all([
		ctx.db.get("messages", message),
		ctx.db.get("users", user),
	]);
	return messageDoc !== null && userDoc !== null;
}

/**
 * Shared validate-then-write core for the membership/like txns (single and
 * batch): these guards must stay in lockstep across every variant, so they
 * live here once with the caller's own error text. The pre-validation
 * itself intentionally differs per variant (single throws on any dangling
 * target, batch skips dangling entries) -- only the membership-existence,
 * single-room, and find-or-insert-like steps are shared.
 */
async function requireMembership(
	ctx: MutationCtx,
	membership: Id<"memberships">,
	notFoundMessage: string,
) {
	const membershipDoc = await ctx.db.get("memberships", membership);
	if (membershipDoc === null) {
		throw new Error(notFoundMessage);
	}
	return membershipDoc;
}

function requireSameRoom(membershipRoom: Id<"rooms">, messageRoom: Id<"rooms">, message: string) {
	if (messageRoom !== membershipRoom) {
		throw new Error(message);
	}
}

async function findOrInsertLike(
	ctx: MutationCtx,
	message: Id<"messages">,
	user: Id<"users">,
): Promise<Id<"likes">> {
	const existing = await findLike(ctx, message, user);
	return existing !== null
		? existing._id
		: await ctx.db.insert("likes", { message, user });
}

// Adding a like is idempotent: when the (message, user) pair already has
// a row, the ack names that row instead of inserting a duplicate.
export const addLike = mutation({
	args: { message: v.id("messages"), user: v.id("users") },
	returns: v.object({
		affectedIds: v.object({ like: v.id("likes") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		if (!(await likeTargetsExist(ctx, args.message, args.user))) {
			throw new Error("addLike: message and user must both exist");
		}
		const like = await findOrInsertLike(ctx, args.message, args.user);
		return { affectedIds: { like }, marker: await bumpMarker(ctx) };
	},
});

export const removeLike = mutation({
	args: { like: v.id("likes") },
	returns: v.object({
		affectedIds: v.object({ like: v.id("likes") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		await ctx.db.delete("likes", args.like);
		return { affectedIds: { like: args.like }, marker: await bumpMarker(ctx) };
	},
});

/**
 * V6: sets a membership's `active` flag and adds a like, in one atomic
 * mutation, so a subscriber can never observe one change without the
 * other (P3's single-write invariant, applied at the Convex source).
 * The like is idempotent like `addLike`, and throws on a dangling
 * message or user instead of writing an orphan. Like the batch variant,
 * it throws on an unknown membership and when the liked message lives in
 * a different room than the patched membership, so one marker never
 * spans two rooms' deltas.
 */
export const membershipAndLikesTxn = mutation({
	args: {
		membership: v.id("memberships"),
		active: v.boolean(),
		message: v.id("messages"),
		user: v.id("users"),
	},
	returns: v.object({
		affectedIds: v.object({ membership: v.id("memberships"), like: v.id("likes") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		// Validate everything before writing anything: membership, then
		// like targets, then the single-room invariant.
		const membershipDoc = await requireMembership(
			ctx,
			args.membership,
			"membershipAndLikesTxn: membership does not exist",
		);
		const [messageDoc, userDoc] = await Promise.all([
			ctx.db.get("messages", args.message),
			ctx.db.get("users", args.user),
		]);
		if (messageDoc === null || userDoc === null) {
			throw new Error("membershipAndLikesTxn: message and user must both exist");
		}
		requireSameRoom(
			membershipDoc.room,
			messageDoc.room,
			"membershipAndLikesTxn: the liked message must be in the membership's room",
		);
		await ctx.db.patch("memberships", args.membership, { active: args.active });
		const like = await findOrInsertLike(ctx, args.message, args.user);
		return {
			affectedIds: { membership: args.membership, like },
			marker: await bumpMarker(ctx),
		};
	},
});

/**
 * 1c U5's multi-table scenario: one membership change plus several likes
 * in a single atomic mutation, so a Data Sync source sees one timestamp
 * group spanning both tables (docs/plans/
 * 2026-09-10-1854-feat-skip-data-sync-push-source-spike-plan.md, U5).
 * `affectedIds.likes` follows `args.likes` order, with one id per written
 * or matched like; entries whose message or user no longer exists are
 * skipped without writing (a no-op, never a resurrection). Likes are
 * idempotent like `addLike`: an entry matching an existing row names that
 * row instead of inserting a duplicate. Every liked message must live in
 * the patched membership's room: a cross-room batch throws before
 * anything is written, so one marker never spans two rooms' deltas.
 */
export const membershipAndLikesBatchTxn = mutation({
	args: {
		membership: v.id("memberships"),
		active: v.boolean(),
		likes: v.array(v.object({ message: v.id("messages"), user: v.id("users") })),
	},
	returns: v.object({
		affectedIds: v.object({ membership: v.id("memberships"), likes: v.array(v.id("likes")) }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		if (args.likes.length === 0 || args.likes.length > 100) {
			throw new Error("membershipAndLikesBatchTxn: likes must have 1 to 100 entries");
		}
		const membershipDoc = await requireMembership(
			ctx,
			args.membership,
			"membershipAndLikesBatchTxn: membership does not exist",
		);
		// Validate everything before writing anything: existence and room
		// for every entry, so a rejection leaves membership, likes, and the
		// marker all untouched.
		const targets = await Promise.all(
			args.likes.map(async (like) => {
				const [messageDoc, userDoc] = await Promise.all([
					ctx.db.get("messages", like.message),
					ctx.db.get("users", like.user),
				]);
				return { like, messageDoc, userDoc };
			}),
		);
		for (const { messageDoc, userDoc } of targets) {
			// Skip dangling entries before the room check, matching the write
			// loop below: a cross-room entry whose user no longer exists is
			// skipped, not rejected.
			if (messageDoc === null || userDoc === null) continue;
			requireSameRoom(
				membershipDoc.room,
				messageDoc.room,
				"membershipAndLikesBatchTxn: every liked message must be in the membership's room",
			);
		}
		await ctx.db.patch("memberships", args.membership, { active: args.active });
		const likes = [];
		for (const { like, messageDoc, userDoc } of targets) {
			if (messageDoc === null || userDoc === null) continue;
			likes.push(await findOrInsertLike(ctx, like.message, like.user));
		}
		return {
			affectedIds: { membership: args.membership, likes },
			marker: await bumpMarker(ctx),
		};
	},
});
