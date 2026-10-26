/**
 * The shared corpus-loading plan both pipelines execute: convex-test's
 * `loadBaseIntoConvexTest` (fixture.ts) and the deployment loader's phased
 * `npx convex import` (scripts/proof-vehicle-load.ts). Previously each side
 * hard-coded the same phase order, message ordering, and natural-key
 * scheme ("in spirit" mirrored per fixture.ts); this module is the one
 * source both import, so the two pipelines cannot silently drift apart.
 *
 * Dependency-free on purpose (no Convex server imports, no Node APIs): it
 * loads in the Convex isolate, under tsx, and under vitest alike.
 */

import type { TableNames } from "../_generated/dataModel";

export type BaseOp =
	| { op: "insertRoom"; label: string; name: string }
	| { op: "insertUser"; label: string; name: string }
	| { op: "insertMembership"; label: string; room: string; user: string; active: boolean }
	| {
			op: "insertMessage";
			label: string;
			room: string;
			sender: string;
			body: string;
			creationTime: number;
	  }
	| { op: "insertLike"; label: string; message: string; user: string };

/** The five contract tables that carry corpus base state. */
export type PhaseTable = Extract<TableNames, "rooms" | "users" | "memberships" | "messages" | "likes">;

export type Phase = { table: PhaseTable; ops: BaseOp[] };

/**
 * Import/insert order, driven by foreign-key dependencies: rooms/users
 * have none; memberships need a room and user; messages need a room and
 * sender; likes need a message and user.
 */
export const TABLE_PHASE_ORDER: readonly PhaseTable[] = [
	"rooms",
	"users",
	"memberships",
	"messages",
	"likes",
];

export function tableForOp(op: BaseOp): PhaseTable {
	switch (op.op) {
		case "insertRoom":
			return "rooms";
		case "insertUser":
			return "users";
		case "insertMembership":
			return "memberships";
		case "insertMessage":
			return "messages";
		case "insertLike":
			return "likes";
	}
}

/**
 * Groups base ops into `TABLE_PHASE_ORDER` phases. Message ops sort
 * ascending by declared `creationTime` (stable, so the corpus's own tie
 * order survives) so wall-clock timestamps assigned at insert land in the
 * corpus's relative order. Never mutates the input: each phase holds a
 * fresh array.
 */
export function groupOpsByPhase(ops: readonly BaseOp[]): Phase[] {
	const byTable: Record<PhaseTable, BaseOp[]> = {
		rooms: [],
		users: [],
		memberships: [],
		messages: [],
		likes: [],
	};
	for (const op of ops) {
		byTable[tableForOp(op)].push(op);
	}
	byTable.messages.sort((a, b) =>
		a.op === "insertMessage" && b.op === "insertMessage" ? a.creationTime - b.creationTime : 0,
	);
	return TABLE_PHASE_ORDER.map((table) => ({ table, ops: byTable[table] }));
}

/**
 * Per-table natural-key fields: rooms/users by `name`, messages by `body`,
 * memberships/likes by their foreign-key pair. One static table drives
 * both the op flavor (labels, resolved by the caller) and the row flavor
 * (raw ids straight from the deployment) through `naturalKey` below.
 */
const NATURAL_KEY_FIELDS: Record<PhaseTable, readonly string[]> = {
	rooms: ["name"],
	users: ["name"],
	messages: ["body"],
	memberships: ["room", "user"],
	likes: ["message", "user"],
};

/**
 * Joins one op/row's natural-key fields with "/". The caller supplies
 * field values: label-resolved ids for ops, raw values for read-back
 * rows. Single-field tables yield the bare value (no separator).
 */
export function naturalKey(table: PhaseTable, getField: (field: string) => string): string {
	return NATURAL_KEY_FIELDS[table].map(getField).join("/");
}
