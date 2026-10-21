/// <reference types="vite/client" />
/**
 * Parity and replay tests for the proof-vehicle corpus: golden base-state
 * hashes, multi-vector delta replay determinism, and corpus self-checks.
 * Vector execution lives in proofVehicle.test.ts; shared loading, binding,
 * and hashing helpers live in ./testHelpers.
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import corpus from "./corpus/v1.json";
import parity from "./corpus/v1.parity.json";
import { computeParity, type BaseOp } from "./fixture";
import {
  applyDelta,
  feedFor,
  runLoadBase,
  type CorpusOutRow,
} from "./testHelpers";
/** Rewrites raw row ids to corpus labels so two independently loaded copies compare equal. */
function normalizeIds(value: unknown, labelByRawId: ReadonlyMap<string, string>): unknown {
	if (typeof value === "string") return labelByRawId.get(value) ?? value;
	if (Array.isArray(value)) return value.map((entry) => normalizeIds(entry, labelByRawId));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, normalizeIds(entry, labelByRawId)]),
		);
	}
	return value;
}

/** Label-mapped parity hashes of all five tables for one loaded copy. */
async function tablesParity(
	t: ReturnType<typeof convexTest>,
	idByLabel: Map<string, Id<TableNames>>,
) {
	const labelByRawId = new Map<string, string>();
	for (const [label, id] of idByLabel) labelByRawId.set(id, label);
	const hashes: Record<string, unknown> = {};
	for (const table of PARITY_TABLES) {
		const rows = await t.run((ctx) => ctx.db.query(table).collect());
		hashes[table] = await computeParity(rows, labelByRawId);
	}
	return { hashes, labelByRawId };
}

test("AE14: replaying one delta log into two independently loaded copies yields equal label-mapped parity hashes", async () => {
	const vector = corpus.vectors.V3;
	const deltas = vector.deltas as { mutation: string; args: Record<string, unknown>; label?: string }[];
	const loadAndReplay = async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		for (const delta of deltas) {
			await applyDelta(t, idByLabel, delta);
		}
		return { t, idByLabel };
	};

	const first = await loadAndReplay();
	const second = await loadAndReplay();
	const firstState = await tablesParity(first.t, first.idByLabel);
	const secondState = await tablesParity(second.t, second.idByLabel);
	expect(firstState.hashes).toEqual(secondState.hashes);

	const room = first.idByLabel.get("r") as Id<"rooms">;
	const feedA = normalizeIds(await feedFor(first.t, room), firstState.labelByRawId);
	const feedB = normalizeIds(await feedFor(second.t, room), secondState.labelByRawId);
	expect(feedA).toEqual(feedB);

	// The replayed deltas took effect: post-replay hashes differ from base-only.
	const base = await (async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		return tablesParity(t, idByLabel);
	})();
	expect(firstState.hashes).not.toEqual(base.hashes);
});

test("AE14: a load that omits one mutation produces a different parity hash", async () => {
	const vector = corpus.vectors.V1;
	const full = await (async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		await applyDelta(t, idByLabel, (vector.deltas as { mutation: string; args: Record<string, unknown> }[])[0]!);
		return tablesParity(t, idByLabel);
	})();

	const partial = await (async () => {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		// Omits the delta (deleteUser) a real replay would have applied.
		return tablesParity(t, idByLabel);
	})();

	expect(full.hashes).not.toEqual(partial.hashes);
});

const PARITY_TABLES = ["rooms", "users", "memberships", "messages", "likes"] as const;

test("computeParity reproduces the vendored corpus/v1.parity.json for every vector's base state", async () => {
	for (const [key, vector] of Object.entries(corpus.vectors)) {
		const t = convexTest(schema, modules);
		const idByLabel = await runLoadBase(t, vector.base as BaseOp[]);
		const labelByRawId = new Map<string, string>();
		for (const [label, id] of idByLabel) labelByRawId.set(id, label);

		const golden = (parity.vectors as Record<string, Record<string, unknown>>)[key]!;
		for (const table of PARITY_TABLES) {
			const rows = await t.run((ctx) => ctx.db.query(table).collect());
			const actual = await computeParity(rows, labelByRawId);
			expect(actual).toEqual(golden[table]);
		}
	}
});

// M3 regression: every vector's declared base message creationTime must
// agree with the same message's declared expectedBase creationTime. Neither
// the convex-test path (creationTime is stripped before comparison) nor
// computeParity (creationTime is dropped from the hash) would ever catch a
// disagreement here -- this is a plain data-consistency check on the corpus
// JSON itself, independent of any Convex query.
test("corpus: base and expectedBase agree for every message, in every vector", () => {
	for (const [key, vector] of Object.entries(corpus.vectors)) {
		const baseMessageByLabel = new Map(
			(vector.base as BaseOp[])
				.filter((op): op is BaseOp & { op: "insertMessage" } => op.op === "insertMessage")
				.map((op) => [op.label, op]),
		);
		for (const row of (vector.expectedBase ?? []) as CorpusOutRow[]) {
			const baseOp = baseMessageByLabel.get(row.id);
			if (baseOp === undefined) {
				throw new Error(
					`${key}: expectedBase "${row.id}" has no matching base insertMessage op`,
				);
			}
			expect(baseOp.creationTime, `${key}: expectedBase "${row.id}" creationTime`).toBe(
				row.creationTime,
			);
			expect(baseOp.body, `${key}: expectedBase "${row.id}" body`).toBe(row.body);
		}
	}
});

const modules = import.meta.glob("/convex/**/*.ts");
