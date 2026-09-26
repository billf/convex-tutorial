import { expect, test } from "vitest";
import {
	buildImportRows,
	legacyMessagesPresent,
	naturalKey,
	planImportPhases,
} from "./proof-vehicle-load";
import corpus from "../convex/proofVehicle/corpus/v1.json";
import type { BaseOp } from "../convex/proofVehicle/fixture";

test("legacyMessagesPresent detects a pre-migration {user, body} row", () => {
	expect(legacyMessagesPresent([{ room: "r1", sender: "u1", body: "hi" }])).toBe(false);
	expect(legacyMessagesPresent([{ user: "u1", body: "hi" }])).toBe(true);
	expect(legacyMessagesPresent([])).toBe(false);
});

test("planImportPhases splits V2's base into rooms, users, memberships, then messages, in that order", () => {
	const phases = planImportPhases(corpus.vectors.V2.base as BaseOp[]);
	expect(phases.map((phase) => phase.table)).toEqual(["rooms", "users", "memberships", "messages"]);
	expect(phases.find((phase) => phase.table === "users")?.ops).toHaveLength(2);
});

test("planImportPhases orders V4's message phase ascending by creationTime, tie included", () => {
	const phases = planImportPhases(corpus.vectors.V4.base as BaseOp[]);
	const messages = phases.find((phase) => phase.table === "messages")!.ops;
	expect(messages).toHaveLength(51);
	expect(messages[0]).toMatchObject({ label: "m01" });
	// m50 and m51 share creationTime 51; stable sort keeps the corpus's
	// own declared order (m51 before m50) for the tie.
	expect(messages.at(-2)).toMatchObject({ label: "m51" });
	expect(messages.at(-1)).toMatchObject({ label: "m50" });
});

test("buildImportRows resolves memberships' room/user labels to real ids", () => {
	const idByLabel = new Map([
		["r", "room-real-id"],
		["u", "user-real-id"],
	]);
	const phase = { table: "memberships" as const, ops: corpus.vectors.V1.base.filter(
		(op): op is Extract<BaseOp, { op: "insertMembership" }> => op.op === "insertMembership",
	) };
	const rows = buildImportRows(phase, idByLabel);
	expect(rows).toEqual([{ room: "room-real-id", user: "user-real-id", active: true }]);
});

test("buildImportRows throws on an unbound label", () => {
	const phase = { table: "memberships" as const, ops: corpus.vectors.V1.base.filter(
		(op): op is Extract<BaseOp, { op: "insertMembership" }> => op.op === "insertMembership",
	) };
	expect(() => buildImportRows(phase, new Map())).toThrow(/unbound label/);
});

// u5 review M2: readBackLabels binds an imported row back to its corpus
// label via naturalKey (name/body/FK-pair), with no enforced uniqueness. A
// future corpus edit that introduces a within-vector duplicate would
// silently mis-bind a label instead of failing loudly. This lints every
// vector's *base* ops (grouped by table, since naturalKey collisions only
// matter within one readBackLabels() call) for that today.
test("corpus: every vector's base ops have unique natural keys, per table", () => {
	for (const [vectorKey, vector] of Object.entries(corpus.vectors)) {
		const byTable = new Map<string, string[]>();
		for (const op of vector.base as BaseOp[]) {
			const table =
				op.op === "insertRoom"
					? "rooms"
					: op.op === "insertUser"
						? "users"
						: op.op === "insertMembership"
							? "memberships"
							: op.op === "insertMessage"
								? "messages"
								: "likes";
			const keys = byTable.get(table) ?? [];
			keys.push(naturalKey(op, new Map()));
			byTable.set(table, keys);
		}
		for (const [table, keys] of byTable) {
			const seen = new Set<string>();
			for (const key of keys) {
				expect(seen.has(key), `${vectorKey}.${table}: duplicate natural key "${key}"`).toBe(
					false,
				);
				seen.add(key);
			}
		}
	}
});

test("buildImportRows offsets messages' _creationTime from a fixed epoch base", () => {
	const idByLabel = new Map([
		["r", "room-real-id"],
		["u", "user-real-id"],
	]);
	const phase = { table: "messages" as const, ops: corpus.vectors.V1.base.filter(
		(op): op is Extract<BaseOp, { op: "insertMessage" }> => op.op === "insertMessage",
	) };
	const [row] = buildImportRows(phase, idByLabel);
	expect(typeof row!["_creationTime"]).toBe("number");
	expect(row!["body"]).toBe("one");
});
