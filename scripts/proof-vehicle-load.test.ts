import { expect, test } from "vitest";
import {
	buildImportRows,
	computeNonEmptyTables,
	importArgs,
	importEnv,
	indexRowsByNaturalKey,
	legacyMessagesPresent,
	naturalKey,
	planImportPhases,
	redactSecrets,
	resolveImportTarget,
	withDeadline,
} from "./proof-vehicle-load";
import corpus from "../convex/proofVehicle/corpus/v1.json";
import type { BaseOp } from "../convex/proofVehicle/fixture";
import { groupOpsByPhase } from "../convex/proofVehicle/basePlan";

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

// The deployment loader and convex-test's loadBaseIntoConvexTest execute
// one shared plan (basePlan.groupOpsByPhase): this pins planImportPhases
// to it -- same phase tables in order, same message label order -- for
// every vector, so a future separate re-implementation fails loudly.
test("planImportPhases follows the shared groupOpsByPhase plan for every vector", () => {
	for (const vector of Object.values(corpus.vectors)) {
		const ops = vector.base as BaseOp[];
		const shared = groupOpsByPhase(ops).filter((phase) => phase.ops.length > 0);
		const planned = planImportPhases(ops);
		expect(planned.map((phase) => phase.table)).toEqual(shared.map((phase) => phase.table));
		for (const phase of planned) {
			const labels = (table: string) =>
				shared.find((p) => p.table === table)?.ops.map((op) => op.label);
			expect(phase.ops.map((op) => op.label)).toEqual(labels(phase.table));
		}
	}
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

test("computeNonEmptyTables returns [] when every table is empty", () => {
	expect(
		computeNonEmptyTables({ rooms: [], users: [], memberships: [], likes: [], messages: [] }),
	).toEqual([]);
});

// Branch-review BR1: rooms/users import with --replace, and convex/chat.ts
// (the live tutorial app) shares those exact tables. A `npm run dev`
// -populated deployment always has rooms/users rows (the first chat message
// lazily creates one of each) well before it has any proof-vehicle
// memberships/messages/likes rows -- this is the specific shape the guard
// must catch to prevent the loader from silently wiping live chat data.
test("computeNonEmptyTables (BR1): flags a deployment with only live chat rooms/users populated", () => {
	expect(
		computeNonEmptyTables({
			rooms: [{ name: "general" }],
			users: [{ name: "Ada" }],
			memberships: [],
			likes: [],
			messages: [],
		}),
	).toEqual(["rooms", "users"]);
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

// I2d/KTD5: the self-hosted path resolves one URL + admin key target
// from the process environment and fails before any import when either
// value is missing.
test("resolveImportTarget returns the URL and admin key when both are set", () => {
	expect(
		resolveImportTarget({ CONVEX_URL: "http://127.0.0.1:3210", PROOF_VEHICLE_ADMIN_KEY: "k" }),
	).toEqual({ url: "http://127.0.0.1:3210", adminKey: "k" });
});

test("resolveImportTarget rejects a missing URL before any import", () => {
	expect(() => resolveImportTarget({ PROOF_VEHICLE_ADMIN_KEY: "k" })).toThrow(/CONVEX_URL/);
	expect(() => resolveImportTarget({ CONVEX_URL: "", PROOF_VEHICLE_ADMIN_KEY: "k" })).toThrow(
		/CONVEX_URL/,
	);
});

test("resolveImportTarget rejects a missing admin key before any import", () => {
	expect(() => resolveImportTarget({ CONVEX_URL: "http://127.0.0.1:3210" })).toThrow(
		/PROOF_VEHICLE_ADMIN_KEY/,
	);
	expect(() =>
		resolveImportTarget({ CONVEX_URL: "http://127.0.0.1:3210", PROOF_VEHICLE_ADMIN_KEY: "" }),
	).toThrow(/PROOF_VEHICLE_ADMIN_KEY/);
});

// I2d/KTD5: the deployment binding travels in the child environment, never
// in argv -- --admin-key on the command line is ps-visible, and Node
// embeds argv in exec-failure messages that land in logs.
test("importArgs carries no credentials and never --deployment", () => {
	const args = importArgs("rooms", "/tmp/rooms.jsonl", true);
	expect(args).toEqual(["convex", "import", "--table", "rooms", "--yes", "--replace", "/tmp/rooms.jsonl"]);
	expect(args).not.toContain("--url");
	expect(args).not.toContain("--admin-key");
	expect(args).not.toContain("--deployment");
});

test("importArgs omits --replace for non-replace phases", () => {
	const args = importArgs("likes", "/tmp/likes.jsonl", false);
	expect(args).not.toContain("--replace");
	expect(args).not.toContain("--deployment");
});

test("importEnv binds the child to the target deployment via env, dropping CONVEX_DEPLOYMENT", () => {
	const env = importEnv(
		{ url: "http://127.0.0.1:3210", adminKey: "k" },
		{ PATH: "/bin", CONVEX_DEPLOYMENT: "prod:abc", CONVEX_URL: "http://other:3210" },
	);
	expect(env["CONVEX_SELF_HOSTED_URL"]).toBe("http://127.0.0.1:3210");
	expect(env["CONVEX_SELF_HOSTED_ADMIN_KEY"]).toBe("k");
	expect(env["CONVEX_DEPLOYMENT"]).toBeUndefined();
	expect(env["PATH"]).toBe("/bin");
});

test("redactSecrets strips the admin key from text bound for logs", () => {
	const target = { url: "http://127.0.0.1:3210", adminKey: "secret-key" };
	expect(redactSecrets("Command failed: npx convex import secret-key", target)).toBe(
		"Command failed: npx convex import [redacted-admin-key]",
	);
	expect(redactSecrets("unrelated failure, no key here", target)).toBe(
		"unrelated failure, no key here",
	);
});

test("indexRowsByNaturalKey maps unique rows and throws loudly on duplicates", () => {
	expect(
		indexRowsByNaturalKey("users", [
			{ _id: "u1", name: "Ada" },
			{ _id: "u2", name: "Bob" },
		]),
	).toEqual(
		new Map([
			["Ada", "u1"],
			["Bob", "u2"],
		]),
	);
	expect(() =>
		indexRowsByNaturalKey("messages", [
			{ _id: "m1", body: "same" },
			{ _id: "m2", body: "same" },
		]),
	).toThrow(/duplicate messages rows share natural key "same"/);
});

test("withDeadline resolves fast reads and names hung ones", async () => {
	await expect(withDeadline(Promise.resolve(42), 1000, "fast read")).resolves.toBe(42);
	await expect(withDeadline(new Promise(() => {}), 10, "hung read")).rejects.toThrow(
		/hung read timed out after 10ms/,
	);
	await expect(withDeadline(Promise.reject(new Error("inner boom")), 1000, "sad")).rejects.toThrow(
		/inner boom/,
	);
});
