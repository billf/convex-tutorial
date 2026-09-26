#!/usr/bin/env -S npx tsx
/**
 * Deployment loader CLI for the shared proof-vehicle corpus (docs/plans/
 * 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U5, KTD5).
 *
 * Loads one corpus vector (V1-V6) into a real Convex deployment: phased
 * `npx convex import` for the base state (rooms/users first with
 * `--replace`, then memberships/messages with resolved foreign keys, then
 * likes), then ID read-back through `proofVehicle/tables:*` queries and
 * label binding. Prints the label-binding map as JSON on stdout so a caller
 * (a harness, or a human) never has to infer real IDs.
 *
 * Does NOT perform V4's post-bind body patch (`proofVehicle/fixture:
 * patchMessageBody`): m50/m51's bodies import verbatim from the corpus.
 * That means the m50/m51 *label binding* is
 * correct (bodies are distinct per-op strings), but the literal
 * m51-before-m50 _creationTime tie order this loader is supposed to prove
 * is NOT established by this script alone: nothing here enforces which of
 * the two random real IDs Convex assigns sorts first. Both gaps -- adding a
 * patch step if one turns out to be needed, and proving the tie order --
 * are the snapshot reference run's job (U11), not this script's.
 *
 * Usage: npx tsx scripts/proof-vehicle-load.ts <V1|V2|V3|V4|V5|V6>
 *
 * Requires both CONVEX_URL (for reads) and CONVEX_DEPLOYMENT (passed
 * explicitly to every `npx convex import`, so writes cannot silently
 * default to a different deployment than CONVEX_URL points at -- see M1 in
 * the u5 review) to point at the same target deployment, both set together
 * by `npx convex dev`'s own env file, and PROOF_VEHICLE_FIXTURE=1 set on
 * that deployment (`npx convex env set PROOF_VEHICLE_FIXTURE 1`) if a
 * delta calls `fixture:reset`.
 *
 * DO NOT point this at the same deployment `npm run dev` uses. rooms/users
 * import with `--replace`, which clears those tables entirely -- and
 * convex/chat.ts (the live tutorial chat app) reads/writes those same
 * tables. This loader refuses to run against any deployment where
 * rooms/users/memberships/messages/likes already has rows (a `npm run dev`
 * deployment always does, from its first chat message onward) unless
 * `PROOF_VEHICLE_ALLOW_NONEMPTY=1` is set -- use a fresh/disposable
 * deployment instead of setting it. Reset first with `npx convex run
 * proofVehicle/fixture:reset '{}'` (requires `PROOF_VEHICLE_FIXTURE=1` on
 * that deployment) if you do need to reuse one.
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

function runConvexImport(
	table: string,
	rows: Record<string, unknown>[],
	replace: boolean,
	deployment: string,
): void {
	const dir = mkdtempSync(join(tmpdir(), "proof-vehicle-load-"));
	const file = join(dir, `${table}.jsonl`);
	writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	try {
		const args = ["convex", "import", "--deployment", deployment, "--table", table, "--yes"];
		if (replace) args.push("--replace");
		args.push(file);
		// A stalled subprocess (network partition, stalled npx resolution,
		// an interactive prompt this non-interactive caller can't answer)
		// must not block the loader indefinitely: time out after 120s.
		execFileSync("npx", args, { stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL" });
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
export function naturalKey(op: BaseOp, idByLabel: ReadonlyMap<string, string>): string {
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

/**
 * Pure predicate behind the pre-import empty-target guard (M2 / BR1): which
 * of the five proof-vehicle tables already have rows. Extracted so the
 * guard's actual decision logic is unit-testable without a live deployment
 * -- the query calls that produce its input cannot be.
 */
export function computeNonEmptyTables(tables: {
	rooms: readonly unknown[];
	users: readonly unknown[];
	memberships: readonly unknown[];
	likes: readonly unknown[];
	messages: readonly unknown[];
}): string[] {
	return (Object.keys(tables) as (keyof typeof tables)[]).filter(
		(table) => tables[table].length > 0,
	);
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
	// The read client (ConvexHttpClient, above) and the write path
	// (`npx convex import`, below) must name the same deployment
	// explicitly: without an explicit flag the import would silently use
	// the CLI's own default resolution (the project's dev deployment),
	// which is only guaranteed to match CONVEX_URL by operator
	// discipline, not by anything this script checks. CONVEX_DEPLOYMENT is
	// the identifier `npx convex import` itself accepts via --deployment;
	// requiring it removes the implicit default, but does not prove it
	// names the same deployment CONVEX_URL points at -- see this commit's
	// message for why that stronger check isn't implemented here.
	const deployment = process.env["CONVEX_DEPLOYMENT"];
	if (deployment === undefined) {
		console.error(
			"proof-vehicle-load.ts: CONVEX_DEPLOYMENT is not set. Every `npx convex import` call " +
				"needs an explicit --deployment target so it cannot silently default to a different " +
				"deployment than CONVEX_URL (the read client) points at. Set it to the same deployment " +
				"as CONVEX_URL, e.g. via `npx convex dev`'s own env file.",
		);
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

	// Only rooms/users import with --replace, which clears the ENTIRE
	// table, not just proof-vehicle rows.
	// rooms/users are the SAME tables convex/chat.ts (the live tutorial app)
	// reads and writes via getOrCreateDefaultRoom/getOrCreateUser -- running
	// this loader against the same deployment `npm run dev` uses would
	// silently delete every real chat room and user with no confirmation
	// prompt. Refusing to run at all when rooms/users (or any proof-vehicle
	// table) already has rows -- which a `npm run dev`-populated deployment
	// always will, since the first chat message lazily creates a room and
	// user -- makes that scenario fail loudly instead of silently, without
	// requiring the loader to know which rows are "its own" (KTD8's schema
	// has no proof-vehicle-specific ownership marker to scope a narrower
	// delete by). Bypass: PROOF_VEHICLE_ALLOW_NONEMPTY=1, for a deployment
	// the operator has explicitly decided is disposable.
	if (process.env["PROOF_VEHICLE_ALLOW_NONEMPTY"] !== "1") {
		// Independent preflight reads: fetch concurrently, then apply the
		// same guard predicate to the same keyed inputs.
		const [rooms, users, memberships, likes] = await Promise.all([
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>("proofVehicle/tables:rooms"),
				{},
			),
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>("proofVehicle/tables:users"),
				{},
			),
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>(
					"proofVehicle/tables:memberships",
				),
				{},
			),
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>("proofVehicle/tables:likes"),
				{},
			),
		]);
		const nonEmptyTables = computeNonEmptyTables({
			rooms,
			users,
			memberships,
			likes,
			messages: existingMessages,
		});
		if (nonEmptyTables.length > 0) {
			throw new Error(
				`non-empty-target: this deployment already has rows in [${nonEmptyTables.join(", ")}]. ` +
					"Running this loader here would either replace live rooms/users data (if this is the " +
					"deployment `npm run dev` uses) or leave a partial import (--replace on rooms/users " +
					"only, requireEmpty on the rest). Use a fresh/disposable deployment, run " +
					"`proofVehicle/fixture:reset` first, or set PROOF_VEHICLE_ALLOW_NONEMPTY=1 to bypass " +
					"this check.",
			);
		}
	}

	const vector = corpus.vectors[vectorId as keyof typeof corpus.vectors];
	const phases = planImportPhases(vector.base as BaseOp[]);
	const idByLabel = new Map<string, string>();

	for (const phase of phases) {
		const rows = buildImportRows(phase, idByLabel);
		const replace = phase.table === "rooms" || phase.table === "users";
		runConvexImport(phase.table, rows, replace, deployment);
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
