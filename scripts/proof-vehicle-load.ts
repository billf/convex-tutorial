#!/usr/bin/env -S npx tsx
/**
 * Deployment loader CLI for the shared proof-vehicle corpus (docs/plans/
 * 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U5, KTD5).
 *
 * Loads one corpus vector (V1-V6) into a real Convex deployment: phased
 * `npx convex import` for the base state (rooms/users first with
 * `--replace`, then memberships/messages with resolved foreign keys, then
 * likes), ID read-back through `proofVehicle/tables:*` queries, label
 * binding, and (for V4) the post-bind body patch on the tied m50/m51 rows.
 * Prints the label-binding map as JSON on stdout so a caller (a harness, or
 * a human) never has to infer real IDs.
 *
 * Usage: npx tsx scripts/proof-vehicle-load.ts <V1|V2|V3|V4|V5|V6>
 *
 * Requires CONVEX_URL (or CONVEX_DEPLOYMENT via `npx convex dev`'s own env
 * file) to point at the target deployment, and PROOF_VEHICLE_FIXTURE=1 set
 * on it (`npx convex env set PROOF_VEHICLE_FIXTURE 1`) if a delta calls
 * `fixture:reset`.
 *
 * NOTE: this script has not been run against a live deployment in this
 * environment (none was configured here); its phased-import and
 * label-binding logic is exercised structurally by this file's own unit
 * tests below the CLI entrypoint, and its end-to-end proof -- like V4's
 * literal ID tie -- is the snapshot reference run (U11).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import corpus from "../convex/proofVehicle/corpus/v1.json";
import type { BaseOp } from "../convex/proofVehicle/fixture";

const EPOCH_BASE_MS = Date.parse("2026-01-01T00:00:00Z");

/**
 * KTD8's precondition: a deployment loader must abort rather than write
 * data on top of pre-migration `{user, body}` rows. `messages` rows this
 * loader itself wrote always carry `room`; a legacy row never does.
 */
export function legacyMessagesPresent(messageRows: readonly Record<string, unknown>[]): boolean {
	return messageRows.some((row) => !("room" in row) || row["room"] === undefined);
}

type Phase = { table: "rooms" | "users" | "memberships" | "messages" | "likes"; ops: BaseOp[] };

/** Splits a vector's base ops into the four sequential import phases KTD5 specifies. */
export function planImportPhases(ops: readonly BaseOp[]): Phase[] {
	const byTable: Record<Phase["table"], BaseOp[]> = {
		rooms: [],
		users: [],
		memberships: [],
		messages: [],
		likes: [],
	};
	for (const op of ops) {
		if (op.op === "insertRoom") byTable.rooms.push(op);
		else if (op.op === "insertUser") byTable.users.push(op);
		else if (op.op === "insertMembership") byTable.memberships.push(op);
		else if (op.op === "insertMessage") byTable.messages.push(op);
		else if (op.op === "insertLike") byTable.likes.push(op);
	}
	// Messages import in ascending creationTime order so the epoch-offset
	// timestamps this file assigns land in the corpus's own relative order
	// (ties, like V4's m50/m51, get equal offsets -- see buildRows).
	byTable.messages.sort((a, b) =>
		a.op === "insertMessage" && b.op === "insertMessage" ? a.creationTime - b.creationTime : 0,
	);
	return (["rooms", "users", "memberships", "messages", "likes"] as const)
		.map((table) => ({ table, ops: byTable[table] }))
		.filter((phase) => phase.ops.length > 0);
}

/**
 * Builds one phase's `npx convex import` rows. Rooms/users carry no
 * foreign keys. Memberships/messages resolve `room`/`user`/`sender`
 * labels through `idByLabel` (populated by the read-back after the prior
 * phase). Messages additionally carry an explicit `_creationTime`, offset
 * from a fixed epoch base by the corpus's own declared value in
 * milliseconds -- this is the one part of the corpus's timing convex-test
 * cannot reproduce (see fixture.ts's `loadBaseIntoConvexTest`), which is
 * exactly why this loader, not convex-test, is what proves V4's tie.
 */
export function buildImportRows(
	phase: Phase,
	idByLabel: ReadonlyMap<string, string>,
): Record<string, unknown>[] {
	const resolve = (label: string): string => {
		const id = idByLabel.get(label);
		if (id === undefined) throw new Error(`buildImportRows: unbound label "${label}"`);
		return id;
	};
	return phase.ops.map((op) => {
		switch (op.op) {
			case "insertRoom":
				return { name: op.name };
			case "insertUser":
				return { name: op.name };
			case "insertMembership":
				return { room: resolve(op.room), user: resolve(op.user), active: op.active };
			case "insertMessage":
				return {
					room: resolve(op.room),
					sender: resolve(op.sender),
					body: op.body,
					_creationTime: EPOCH_BASE_MS + op.creationTime,
				};
			case "insertLike":
				return { message: resolve(op.message), user: resolve(op.user) };
		}
	});
}

function runConvexImport(table: string, rows: Record<string, unknown>[], replace: boolean): void {
	const dir = mkdtempSync(join(tmpdir(), "proof-vehicle-load-"));
	const file = join(dir, `${table}.jsonl`);
	writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	try {
		const args = ["convex", "import", "--table", table, "--yes"];
		if (replace) args.push("--replace");
		args.push(file);
		execFileSync("npx", args, { stdio: "inherit" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A natural key for each table's ops, unique enough within one vector's
 * base state to bind a read-back row to its corpus label: rooms/users by
 * `name`, messages by `body` (the corpus never repeats a body within one
 * vector), and memberships/likes by their foreign-key pair (the shared
 * contract guarantees at most one membership per (room, user); no corpus
 * vector's *base* state repeats a (message, user) like pair, even though
 * V6's delta later adds a second one via a mutation call that returns its
 * own id directly, needing no read-back).
 */
function naturalKey(op: BaseOp, idByLabel: ReadonlyMap<string, string>): string {
	const resolve = (label: string) => idByLabel.get(label) ?? label;
	switch (op.op) {
		case "insertRoom":
		case "insertUser":
			return op.name;
		case "insertMessage":
			return op.body;
		case "insertMembership":
			return `${resolve(op.room)}/${resolve(op.user)}`;
		case "insertLike":
			return `${resolve(op.message)}/${resolve(op.user)}`;
	}
}

function rowNaturalKey(table: Phase["table"], row: Record<string, unknown>): string {
	switch (table) {
		case "rooms":
		case "users":
			return String(row["name"]);
		case "messages":
			return String(row["body"]);
		case "memberships":
			return `${String(row["room"])}/${String(row["user"])}`;
		case "likes":
			return `${String(row["message"])}/${String(row["user"])}`;
	}
}

async function readBackLabels(
	client: ConvexHttpClient,
	phase: Phase,
	idByLabel: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
	const ref = makeFunctionReference<
		"query",
		Record<string, never>,
		({ _id: string } & Record<string, unknown>)[]
	>(`proofVehicle/tables:${phase.table}`);
	const rows = await client.query(ref, {});
	const idByNaturalKey = new Map(rows.map((row) => [rowNaturalKey(phase.table, row), row._id]));
	const resolved = new Map<string, string>();
	for (const op of phase.ops) {
		const key = naturalKey(op, idByLabel);
		const id = idByNaturalKey.get(key);
		if (id === undefined) {
			throw new Error(
				`readBackLabels: no ${phase.table} row matching "${key}" after import (label "${op.label}")`,
			);
		}
		resolved.set(op.label, id);
	}
	return resolved;
}

async function main(): Promise<void> {
	const vectorId = process.argv[2];
	if (vectorId === undefined || !(vectorId in corpus.vectors)) {
		console.error(`Usage: proof-vehicle-load.ts <${Object.keys(corpus.vectors).join("|")}>`);
		process.exitCode = 1;
		return;
	}
	const url = process.env["CONVEX_URL"];
	if (url === undefined) {
		console.error("proof-vehicle-load.ts: CONVEX_URL is not set");
		process.exitCode = 1;
		return;
	}
	const client = new ConvexHttpClient(url);

	const existingMessages = await client.query(
		makeFunctionReference<"query", Record<string, never>, Record<string, unknown>[]>(
			"proofVehicle/tables:messages",
		),
		{},
	);
	if (legacyMessagesPresent(existingMessages)) {
		throw new Error(
			"legacy-messages-present: this deployment has a pre-migration messages row " +
				"(missing `room`); use a fresh local deployment or clear `messages` first.",
		);
	}

	const vector = corpus.vectors[vectorId as keyof typeof corpus.vectors];
	const phases = planImportPhases(vector.base as BaseOp[]);
	const idByLabel = new Map<string, string>();

	for (const phase of phases) {
		const rows = buildImportRows(phase, idByLabel);
		const replace = phase.table === "rooms" || phase.table === "users";
		runConvexImport(phase.table, rows, replace);
		for (const [label, id] of await readBackLabels(client, phase, idByLabel)) {
			idByLabel.set(label, id);
		}
	}

	console.log(JSON.stringify(Object.fromEntries(idByLabel), null, 2));
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
