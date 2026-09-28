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
 * Requires CONVEX_URL and PROOF_VEHICLE_ADMIN_KEY in this process's
 * environment (`tsx` does not load `.env.local` automatically): the URL
 * names the self-hosted deployment for reads, and the same URL plus key
 * are passed explicitly to every `npx convex import` (no `--deployment`
 * -- the Convex CLI does not allow it with self-hosted credentials), so
 * writes cannot silently default to a different deployment than reads
 * use. Also requires PROOF_VEHICLE_FIXTURE=1 set on that deployment
 * (`npx convex env set PROOF_VEHICLE_FIXTURE 1`) if a delta calls
 * `fixture:reset`.
 *
 * DO NOT point this at the same deployment `npm run dev` uses. rooms/users
 * import with `--replace`, which clears those tables entirely -- and
 * convex/chat.ts (the live tutorial chat app) reads/writes those same
 * tables. This loader refuses to run against any deployment where
 * rooms/users/memberships/messages/likes already has rows (a `npm run dev`
 * deployment always does, from its first chat message onward). Reset first
 * with `npx convex run proofVehicle/fixture:reset '{}'` (requires
 * `PROOF_VEHICLE_FIXTURE=1` on that deployment) or point at a fresh
 * deployment -- do not just set `PROOF_VEHICLE_ALLOW_NONEMPTY=1` to skip
 * the check; on a nonempty target that still replaces rooms/users and can
 * still leave a partial import (see the error text this throws for why).
 *
 * The emptiness check is point-in-time (once before the run, and again
 * immediately before each --replace phase) with no lock held across the
 * import -- run this only against a deployment with no other writer
 * (nothing else calling chat:sendMessage/getOrCreateUser or the
 * proofVehicle mutations) for its duration.
 *
 * NOTE: V1 has been run against a live self-hosted deployment in this
 * environment (local backend on 127.0.0.1:3210, using the I2d CONVEX_URL /
 * PROOF_VEHICLE_ADMIN_KEY path); its phased-import and label-binding
 * logic is further exercised structurally by this file's own unit tests
 * below the CLI entrypoint, and its end-to-end proof -- like V4's
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

/**
 * Self-hosted import target (I2d/KTD5): the deployment's URL and admin
 * key, used for both reads (ConvexHttpClient) and every
 * `npx convex import`. The explicit `--url`/`--admin-key` path writes
 * CONVEX_URL but removes CONVEX_DEPLOYMENT, and the Convex CLI does not
 * allow `--deployment` with self-hosted credentials -- so imports carry
 * the same URL and key instead of a deployment name.
 */
export type ImportTarget = { url: string; adminKey: string };

/**
 * Resolves the self-hosted target from the process environment, failing
 * before any import when either value is missing.
 */
export function resolveImportTarget(env: NodeJS.ProcessEnv): ImportTarget {
	const url = env["CONVEX_URL"];
	if (url === undefined || url === "") {
		throw new Error(
			"resolveImportTarget: CONVEX_URL is not set. Set it to the self-hosted deployment URL, " +
				"matching the generated `.env.local`.",
		);
	}
	const adminKey = env["PROOF_VEHICLE_ADMIN_KEY"];
	if (adminKey === undefined || adminKey === "") {
		throw new Error(
			"resolveImportTarget: PROOF_VEHICLE_ADMIN_KEY is not set. Supply it from " +
				"`just generate-admin-key` in the backend checkout.",
		);
	}
	return { url, adminKey };
}

/**
 * Builds one `npx convex import` argv (without the leading `npx`) for a
 * phase file. Extracted so the self-hosted flag shape is unit-testable
 * without a live deployment -- the subprocess call itself cannot be.
 */
export function importArgs(
	table: string,
	file: string,
	replace: boolean,
	target: ImportTarget,
): string[] {
	const args = [
		"convex",
		"import",
		"--url",
		target.url,
		"--admin-key",
		target.adminKey,
		"--table",
		table,
		"--yes",
	];
	if (replace) args.push("--replace");
	args.push(file);
	return args;
}

function runConvexImport(
	table: string,
	rows: Record<string, unknown>[],
	replace: boolean,
	target: ImportTarget,
): void {
	const dir = mkdtempSync(join(tmpdir(), "proof-vehicle-load-"));
	const file = join(dir, `${table}.jsonl`);
	writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	try {
		const args = importArgs(table, file, replace, target);
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
	// Reads (ConvexHttpClient, below) and writes (`npx convex import`,
	// further below) target one self-hosted deployment via the same URL
	// and admin key (I2d/KTD5). `tsx` does not load `.env.local`
	// automatically, so both arrive in this process's environment.
	let target: ImportTarget;
	try {
		target = resolveImportTarget(process.env);
	} catch (error) {
		console.error(`proof-vehicle-load.ts: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
		return;
	}
	const url = target.url;
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
					"only, requireEmpty on the rest). Use a fresh/disposable deployment, or run " +
					"`proofVehicle/fixture:reset` first and re-run. PROOF_VEHICLE_ALLOW_NONEMPTY=1 skips " +
					"this check entirely -- it is NOT a safe alternative to reset: on a nonempty target it " +
					"still replaces rooms/users and can still hit requireEmpty rejections on " +
					"memberships/messages/likes, leaving fresh rooms/users IDs with stale rows pointing at " +
					"the old (now-deleted) ones. Only set it on a deployment you have separately verified " +
					"is safe to lose all proof-vehicle-table data on, and prefer reset first regardless.",
			);
		}
	}

	const vector = corpus.vectors[vectorId as keyof typeof corpus.vectors];
	const phases = planImportPhases(vector.base as BaseOp[]);
	const idByLabel = new Map<string, string>();

	for (const phase of phases) {
		const replace = phase.table === "rooms" || phase.table === "users";
		// The preflight guard above is point-in-time and holds no lock across
		// this loop; live traffic (a chat message, sendMessage's BR8
		// membership write) landing after it passes and before a --replace
		// phase runs would be silently destroyed by that --replace. This
		// can't close the race -- Convex has no cross-request lock this
		// script can take -- but re-checking immediately before each
		// --replace phase (rather than only once, before all five) shrinks
		// the window from "the whole script's runtime" to "between this
		// check and the next subprocess call".
		if (replace && process.env["PROOF_VEHICLE_ALLOW_NONEMPTY"] !== "1") {
			const rows = await client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>(
					`proofVehicle/tables:${phase.table}`,
				),
				{},
			);
			if (rows.length > 0) {
				throw new Error(
					`non-empty-target: ${phase.table} gained rows after the initial preflight check ` +
						"(likely live traffic during this run). Refusing to --replace it. Re-run after " +
						"confirming the deployment is quiesced.",
				);
			}
		}
		const rows = buildImportRows(phase, idByLabel);
		runConvexImport(phase.table, rows, replace, target);
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
