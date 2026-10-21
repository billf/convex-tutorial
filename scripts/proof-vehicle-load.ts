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
 * names the self-hosted deployment for reads, and each `npx convex import`
 * child receives the same URL plus key via its environment (never on argv;
 * see the key-hygiene note below; no `--deployment` -- the Convex CLI does
 * not allow it with self-hosted credentials), so writes cannot silently
 * default to a different deployment than reads use. Also requires
 * delta calls `fixture:reset` -- set it via the same self-hosted env pair
 * the imports use: with `CONVEX_SELF_HOSTED_URL="$CONVEX_URL"` and
 * `CONVEX_SELF_HOSTED_ADMIN_KEY` exported (see the key-hygiene note
 * below), run `npx convex env set PROOF_VEHICLE_FIXTURE 1` with no flags.
 * A bare `npx convex env set` without that pair targets the CLI's own
 * default dev deployment instead, which can silently differ from CONVEX_URL.
 *
 * Key hygiene: each import child reads the admin key from a per-phase env
 * file (`--env-file` in the phase temp dir, mode 0600) instead of argv or
 * the inherited environment -- so the key is invisible to `ps`, never
 * lands in shell history from the loader's own commands, and cannot be
 * reintroduced by a dotenv reload or stale export in the loader's cwd.
 * Same-host file reads during the seconds an import runs remain possible:
 * treat a load host as single-operator for its duration. The
 * operator-typed commands in this header authenticate the same way (env
 * pair, no flags): export the pair per session from a 0600 file or
 * `read -s`, never paste the key into tickets, chat, or an inline
 * `VAR=value` command prefix.
 * DO NOT point this at the same deployment `npm run dev` uses. rooms/users
 * import with `--replace`, which clears those tables entirely -- and
 * convex/chat.ts (the live tutorial chat app) reads/writes those same
 * tables. This loader refuses to run against any deployment where
 * rooms/users/memberships/messages/likes already has rows (a `npm run dev`
 * deployment always does, from its first chat message onward). Reset first
 * with `npx convex run proofVehicle/fixture:reset '{}'` under the same
 * env pair (no flags)` (requires `PROOF_VEHICLE_FIXTURE=1`
 * on that deployment; the same env-pair binding matters here too -- a bare
 * `npx convex run` without it targets the CLI's default dev deployment, not
 * necessarily the one this loader just checked) or point at a fresh
 * deployment -- the guard has no override flag, so a stale bypass cannot
 * linger into a later run against a live deployment.
 *
 * The emptiness check is point-in-time (once before the run, and again
 * immediately before each --replace phase) with no lock held across the
 * import -- run this only against a deployment with no other writer
 * (nothing else calling chat:sendMessage/getOrCreateUser or the
 * proofVehicle mutations) for its duration.
 *
 * NOTE (one true story, mirrored in AGENTS.md): this loader has not been
 * run end-to-end in this environment; its phased-import and label-binding
 * logic is exercised structurally by this file's own unit tests below the
 * CLI entrypoint, and end-to-end proof is the snapshot reference run
 * (U11). On V4's tie: this script preserves the corpus's relative order
 * and stamps equal `_creationTime` offsets for tied rows -- the raw
 * material a tie proof needs -- but it does NOT determine the tied pair's
 * order (Convex assigns real IDs randomly), so proving the literal
 * m51-before-m50 order is U11's job, not this script's.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import corpus from "../convex/proofVehicle/corpus/v1.json";
import type { BaseOp } from "../convex/proofVehicle/fixture";

export const EPOCH_BASE_MS = Date.parse("2026-01-01T00:00:00Z");

/**
 * KTD8's precondition: a deployment loader must abort rather than write
 * data on top of pre-migration `{user, body}` rows. `messages` rows this
 * loader itself wrote always carry `room`; a legacy row never does.
 */
export function legacyMessagesPresent(messageRows: readonly Record<string, unknown>[]): boolean {
	return messageRows.some((row) => !("room" in row) || row["room"] === undefined);
}

export type Phase = { table: "rooms" | "users" | "memberships" | "messages" | "likes"; ops: BaseOp[] };

/** Splits a vector's base ops into the five sequential import phases KTD5 specifies. */
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
 * cannot reproduce (see fixture.ts's `loadBaseIntoConvexTest`). Preserving
 * exact offsets (and equal values for ties) is the raw material V4's tie
 * proof needs; determining the tied pair's order is U11's job (see the
 * header NOTE), not this function's.
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
		// Label resolution lives in one place (#4): opTableAndFields maps
		// each op to its table plus fully-resolved import fields, and
		// naturalKey selects the key subset from that same map -- a field
		// added for one consumer reaches the other through the shared
		// switch, never through a parallel copy. Only the import-only
		// `_creationTime` is added here.
		const [, fields] = opTableAndFields(op, resolve);
		return op.op === "insertMessage"
			? { ...fields, _creationTime: EPOCH_BASE_MS + op.creationTime }
			: fields;
	});
}

/**
 * Self-hosted import target (I2d/KTD5): the deployment's URL and admin
 * key, used for reads (ConvexHttpClient) and written per phase to the
 * import child's env file (see `writeImportEnvFile`). The explicit
 * flag-based path writes CONVEX_URL but removes CONVEX_DEPLOYMENT, and
 * the Convex CLI does not allow `--deployment` with self-hosted
 * credentials -- so imports carry the same URL and key instead of a
 * deployment name.
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
 * phase file. Carries no credentials: the child reads the target pair
 * from the per-phase env file (`--env-file`) instead of argv, so neither
 * `ps` nor the failure error text (see `sanitizedImportError`) can leak
 * the key. Extracted so the flag shape stays unit-testable without a live
 * deployment -- the subprocess call itself cannot be.
 */
export function importArgs(
	table: Phase["table"],
	file: string,
	envFile: string,
	replace: boolean,
): string[] {
	const args = ["convex", "import", "--table", table, "--yes"];
	if (replace) args.push("--replace");
	args.push("--env-file", envFile);
	args.push(file);
	return args;
}

/**
 * Writes the self-hosted pair to a per-phase env file for one
 * `npx convex import` child. The CLI resolves deployment selection from
 * that file alone (no flags, and the inherited environment is not
 * consulted for selection), so neither a dotenv reload in the loader's
 * cwd (`.env.local` carrying a stale `CONVEX_DEPLOYMENT`) nor a stale
 * exported credential var can divert or crash selection: the file is the
 * single source of truth for that child.
 */
export function writeImportEnvFile(dir: string, target: ImportTarget): string {
	const path = join(dir, "convex-env");
	writeFileSync(
		path,
		`CONVEX_SELF_HOSTED_URL=${target.url}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${target.adminKey}\n`,
		{ mode: 0o600 },
	);
	return path;
}

/**
 * Rewrites a failed `execFileSync` import error without the secret: Node
 * renders the full child argv (including any admin-key value) into the
 * thrown error's message, and the entrypoint logs whatever it catches --
 * so the raw error must never reach `console.error`.
 */
export function sanitizedImportError(table: Phase["table"], error: unknown): Error {
	let outcome = "status unknown";
	if (typeof error === "object" && error !== null) {
		if ("signal" in error && error.signal !== null && error.signal !== undefined) {
			outcome = `signal ${String(error.signal)}`;
		} else if ("status" in error) {
			outcome = `status ${String(error.status)}`;
		}
	}
	return new Error(
		`convex import --table ${table} failed (${outcome}); ` +
			"the failing command and admin key are intentionally omitted here. " +
			"Prior phases may have left partial data and the nonempty-target guard " +
			"refuses a bare rerun: run `proofVehicle/fixture:reset` " +
			"(`PROOF_VEHICLE_FIXTURE=1` on that deployment) or use a fresh " +
			"deployment, then rerun the loader from the start.",
	);
}

/**
 * Runs one deployment read with a deadline and bounded retries. Every
 * `client.query` in `main` and `readBackLabels` goes through here: a
 * stalled deployment must fail loudly (not hang the loader forever), and
 * a single transient blip must not abort the whole run into the manual
 * reset-and-rerun path. Retries use linear backoff (`delayMs * attempt`).
 * The label names the read (phase/table) so the thrown error attributes
 * a failure to the step that owns it.
 */
// NOTE: executor form, not Promise.withResolvers -- the repo pins
// TypeScript ~5.0, whose lib predates withResolvers (TS 5.2+).
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
	});
	const guarded = promise.then(
		(value) => {
			clearTimeout(timer);
			return value;
		},
		(error) => {
			clearTimeout(timer);
			throw error;
		},
	);
	// The race loser may reject after the winner settles; a handler must
	// be attached or Node reports an unhandled rejection.
	void guarded.catch(() => {});
	return Promise.race([guarded, timeout]);
}

export async function queryWithRetry<T>(
	label: string,
	run: () => Promise<T>,
	opts?: { attempts?: number; timeoutMs?: number; delayMs?: number },
): Promise<T> {
	const attempts = Math.max(1, opts?.attempts ?? 3);
	const timeoutMs = opts?.timeoutMs ?? 30_000;
	const delayMs = opts?.delayMs ?? 1_000;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await withTimeout(run(), timeoutMs, label);
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await sleep(delayMs * attempt);
		}
	}
	const detail = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`${label}: deployment read failed after ${attempts} attempt(s) (${detail})`);
}

function runConvexImport(
	table: Phase["table"],
	rows: Record<string, unknown>[],
	replace: boolean,
	target: ImportTarget,
): void {
	const dir = mkdtempSync(join(tmpdir(), "proof-vehicle-load-"));
	// Every write below lands inside `dir` (including the env file
	// carrying the admin key), so all of them run inside the try whose
	// finally removes the directory: a throwing write cannot leave the
	// secret behind. `mkdtempSync` itself stays outside -- if it throws,
	// no directory (and no secret) exists yet.
	try {
		const file = join(dir, `${table}.jsonl`);
		writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
		const args = importArgs(table, file, writeImportEnvFile(dir, target), replace);
		try {
			// A stalled subprocess (network partition, stalled npx resolution,
			// an interactive prompt this non-interactive caller can't answer)
			// must not block the loader indefinitely: time out after 120s.
			execFileSync("npx", args, { stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL" });
		} catch (error) {
			throw sanitizedImportError(table, error);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Per-table natural-key fields, shared by corpus ops (`naturalKey`) and
 * read-back rows (`rowNaturalKey`): rooms/users by `name`, messages by
 * `body` (the corpus never repeats a body within one vector), and
 * memberships/likes by their foreign-key pair. `opTableAndFields` is the
 * single switch that resolves labels; this map only selects the key
 * subset from its output. Edit the switch when the field shape changes,
 * this map when the key shape changes.
 */
const TABLE_NATURAL_KEY_FIELDS = {
	rooms: ["name"],
	users: ["name"],
	memberships: ["room", "user"],
	messages: ["body"],
	likes: ["message", "user"],
} as const satisfies Record<Phase["table"], readonly string[]>;

function joinKey(table: Phase["table"], getField: (field: string) => unknown): string {
	return TABLE_NATURAL_KEY_FIELDS[table].map((field) => String(getField(field))).join("/");
}

function opTableAndFields(
	op: BaseOp,
	resolve: (label: string) => string,
): [Phase["table"], Record<string, unknown>] {
	switch (op.op) {
		case "insertRoom":
			return ["rooms", { name: op.name }];
		case "insertUser":
			return ["users", { name: op.name }];
		case "insertMessage":
			// Full import fields (not just the natural-key body):
			// `naturalKey` selects its key subset from this same map via
			// TABLE_NATURAL_KEY_FIELDS, and `buildImportRows` adds only the
			// import-only `_creationTime` on top.
			return [
				"messages",
				{ room: resolve(op.room), sender: resolve(op.sender), body: op.body },
			];
		case "insertMembership":
			return ["memberships", { room: resolve(op.room), user: resolve(op.user), active: op.active }];
		case "insertLike":
			return ["likes", { message: resolve(op.message), user: resolve(op.user) }];
	}
}

/**
 * A natural key for each table's ops, unique enough within one vector's
 * base state to bind a read-back row to its corpus label. Field selection
 * lives in `TABLE_NATURAL_KEY_FIELDS`; this only resolves labels.
 */
export function naturalKey(op: BaseOp, idByLabel: ReadonlyMap<string, string>): string {
	const resolve = (label: string) => idByLabel.get(label) ?? label;
	const [table, fields] = opTableAndFields(op, resolve);
	return joinKey(table, (field) => fields[field]);
}

/** The same key for a read-back row: must stay identical to `naturalKey` for the same logical row. */
export function rowNaturalKey(table: Phase["table"], row: Record<string, unknown>): string {
	return joinKey(table, (field) => row[field]);
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
	const rows = await queryWithRetry(`read-back ${phase.table}`, () => client.query(ref, {}));
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
 * Pure predicate behind the pre-import empty-target guard: which
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

	const existingMessages = await queryWithRetry("preflight messages", () =>
		client.query(
			makeFunctionReference<"query", Record<string, never>, Record<string, unknown>[]>(
				"proofVehicle/tables:messagesRaw",
			),
			{},
		),
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
	// delete by). There is deliberately no bypass: a stale
	// PROOF_VEHICLE_ALLOW_NONEMPTY-style override retained from a disposable
	// load could otherwise skip this guard after CONVEX_URL is repointed at
	// a live deployment. To load onto a nonempty deployment, run
	// `proofVehicle/fixture:reset` first (it refuses without
	// PROOF_VEHICLE_FIXTURE=1 on that deployment) or use a fresh one.
	// Independent preflight reads: fetch concurrently, then apply the
	// same guard predicate to the same keyed inputs.
	const [rooms, users, memberships, likes] = await Promise.all([
		queryWithRetry("preflight rooms", () =>
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>(
					"proofVehicle/tables:rooms",
				),
				{},
			),
		),
		queryWithRetry("preflight users", () =>
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>(
					"proofVehicle/tables:users",
				),
				{},
			),
		),
		queryWithRetry("preflight memberships", () =>
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>(
					"proofVehicle/tables:memberships",
				),
				{},
			),
		),
		queryWithRetry("preflight likes", () =>
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>(
					"proofVehicle/tables:likes",
				),
				{},
			),
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
				"`proofVehicle/fixture:reset` first and re-run.",
		);
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
		if (replace) {
			const rows = await queryWithRetry(`recheck ${phase.table}`, () =>
				client.query(
					makeFunctionReference<"query", Record<string, never>, unknown[]>(
						`proofVehicle/tables:${phase.table}`,
					),
					{},
				),
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
