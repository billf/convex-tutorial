/**
 * Q13's deterministic mutations (docs/plans/
 * 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U5). Every
 * mutation returns `{affectedIds, marker}`: `affectedIds` names the rows it
 * wrote so a recorder can key on them, and `marker` (from `bumpMarker`) is
 * a harness-readable completion ack a caller can start wall-clock timers
 * from without inferring internal Convex timestamps.
 */

import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { bumpMarker, patchMessageBodyImpl } from "./fixture";

export const sendMessage = mutation({
	args: { room: v.id("rooms"), sender: v.id("users"), body: v.string() },
	returns: v.object({
		affectedIds: v.object({ message: v.id("messages") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		const message = await ctx.db.insert("messages", {
			room: args.room,
			sender: args.sender,
			body: args.body,
		});
		return { affectedIds: { message }, marker: await bumpMarker(ctx) };
	},
});

// Delegates to fixture.ts's patchMessageBodyImpl: this mutation and
// proofVehicle/fixture:patchMessageBody were previously byte-identical,
// separately-maintained handlers (u5 review M8); sharing one implementation
// means they can no longer silently drift apart.
export const updateMessageBody = mutation({
	args: { message: v.id("messages"), body: v.string() },
	returns: v.object({
		affectedIds: v.object({ message: v.id("messages") }),
		marker: v.number(),
	}),
	handler: patchMessageBodyImpl,
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

// Adding a like never deduplicates (message, user): V6's transaction adds a
// second like by "b" on "a1", so a like row is always inserted fresh.
export const addLike = mutation({
	args: { message: v.id("messages"), user: v.id("users") },
	returns: v.object({
		affectedIds: v.object({ like: v.id("likes") }),
		marker: v.number(),
	}),
	handler: async (ctx, args) => {
		const like = await ctx.db.insert("likes", { message: args.message, user: args.user });
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
		await ctx.db.patch("memberships", args.membership, { active: args.active });
		const like = await ctx.db.insert("likes", { message: args.message, user: args.user });
		return {
			affectedIds: { membership: args.membership, like },
			marker: await bumpMarker(ctx),
		};
	},
});
