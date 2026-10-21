#!/usr/bin/env -S npx tsx
/**
 * Deployment loader CLI for the shared proof-vehicle corpus (docs/plans/
 * 2026-09-11-1159-feat-skip-shared-prerequisites-plan.md, U5, KTD5).
 *
 * Loads one corpus vector (V1-V6) into a real Convex deployment: phased
 * `npx convex import` for the base state (rooms/users first, then
 * memberships/messages with resolved foreign keys, then likes), then ID
 * read-back through `proofVehicle/tables:*` queries and label binding.
 * Prints the label-binding map as JSON on stdout so a caller
 * (a harness, or a human) never has to infer real IDs. Every phase
 * imports with require-empty semantics (no `--replace` anywhere): any
 * pre-existing row aborts the run before anything is written.
 *
 * Does NOT perform V4's post-bind body patch (`proofVehicle/mutations:
 * updateMessageBody`): m50/m51's bodies import verbatim from the corpus.
 * That means the m50/m51 *label binding* is
 * correct (bodies are distinct per-op strings), but the literal
 * m51-before-m50 _creationTime tie order this loader is supposed to prove
 * is NOT established by this script alone: nothing here enforces which of
 * the two random real IDs Convex assigns sorts first. Both gaps -- adding a
 * patch step if one turns out to be needed, and proving the tie order --
 * are the snapshot reference run's job (U11), not this script's.
 *
 * Requires CONVEX_URL and PROOF_VEHICLE_ADMIN_KEY in this process's
 * environment (`tsx` does not load `.env.local` automatically): the URL
 * names the self-hosted deployment for reads, and both values are passed
 * explicitly into every `npx convex import` child's environment as
 * CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY (the Convex CLI's
 * documented env alternative to `--url`/`--admin-key`; the key never
 * appears in argv, where `ps` and exec-failure logs would expose it), so
 * writes cannot silently default to a different deployment than reads
 * use. Also requires PROOF_VEHICLE_FIXTURE=1 set on that deployment if a
 * delta calls `fixture:reset` -- set it with the same URL/key binding as
 * every import here, e.g. via the same child-env mechanism. A bare
 * `npx convex env set` (no URL/key binding) targets the CLI's own default
 * dev deployment instead, which can silently differ from CONVEX_URL.
 *
 * DO NOT point this at the same deployment `npm run dev` uses: a `npm run
 * dev`-populated deployment always has rows (from its first chat message
 * onward), and this loader refuses to run unless every proof-vehicle
 * table is empty. Reset first with the key in the environment, never in
 * argv (argv is ps-visible):
 * `CONVEX_SELF_HOSTED_URL="$CONVEX_URL"
 * CONVEX_SELF_HOSTED_ADMIN_KEY="$PROOF_VEHICLE_ADMIN_KEY" npx convex run
 * proofVehicle/fixture:reset '{}'` (requires `PROOF_VEHICLE_FIXTURE=1`
 * on that deployment; the same URL/key binding matters here too
 * -- a bare `npx convex run` targets the CLI's default dev deployment, not
 * necessarily the one this loader just checked) or point at a fresh
 * deployment.
 *
 * The emptiness check is point-in-time (once before the run, and again
 * immediately before each phase) with no lock held across the import --
 * run this only against a deployment with no other writer (nothing else
 * calling chat:sendMessage/getOrCreateUser or the proofVehicle mutations)
 * for its duration. Without --replace, a concurrent write fails the run
 * loudly instead of being silently destroyed.
 *
 * NOTE: V1 has been run against a live self-hosted deployment in this
 * environment (local backend on 127.0.0.1:3210, using the I2d CONVEX_URL /
 * PROOF_VEHICLE_ADMIN_KEY path); its phased-import and label-binding
 * logic is further exercised structurally by this file's own unit tests
 * below the CLI entrypoint, and its end-to-end proof -- like V4's
 * literal ID tie -- is the snapshot reference run (U11).
 */

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import corpus from "../convex/proofVehicle/corpus/v1.json";
import type { BaseOp, Phase } from "../convex/proofVehicle/basePlan";
import { groupOpsByPhase, naturalKey as sharedNaturalKey, tableForOp } from "../convex/proofVehicle/basePlan";

/** Minimal spawn surface runImportChild needs (real or fake in tests). */
export type SpawnChildFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

// Toolchain note: typescript@5.0's lib predates Promise.withResolvers
// (runtime Node here is v22+). Declare the shape locally rather than
// restructuring around a `new Promise` executor.
declare global {
	interface PromiseConstructor {
		withResolvers<T>(): {
			promise: Promise<T>;
			resolve: (value: T | PromiseLike<T>) => void;
			reject: (reason?: unknown) => void;
		};
	}
}
const EPOCH_BASE_MS = Date.parse("2026-01-01T00:00:00Z");

/**
 * KTD8's precondition: a deployment loader must abort rather than write
 * data on top of pre-migration `{user, body}` rows. `messages` rows this
 * loader itself wrote always carry `room`; a legacy row never does.
 */
export function legacyMessagesPresent(messageRows: readonly Record<string, unknown>[]): boolean {
	return messageRows.some((row) => !("room" in row) || row["room"] === undefined);
}

/** Splits a vector's base ops into the sequential import phases KTD5 specifies. */
export function planImportPhases(ops: readonly BaseOp[]): Phase[] {
	// The phase order and message ordering are the shared loading plan
	// (`basePlan.groupOpsByPhase`), the same one convex-test's
	// `loadBaseIntoConvexTest` executes: one definition, two pipelines.
	// Messages import in ascending creationTime order so the epoch-offset
	// timestamps this file assigns land in the corpus's own relative order
	// (ties, like V4's m50/m51, get equal offsets -- see buildImportRows).
	return groupOpsByPhase(ops).filter((phase) => phase.ops.length > 0);
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
 * key, used for reads (ConvexHttpClient) and -- via `importEnv` -- for
 * every `npx convex import` child's environment. The explicit child env
 * carries CONVEX_SELF_HOSTED_URL/CONVEX_SELF_HOSTED_ADMIN_KEY but removes
 * CONVEX_DEPLOYMENT, and the Convex CLI does not allow `--deployment`
 * with self-hosted credentials -- so imports resolve the same deployment
 * reads use, never the CLI's default dev deployment.
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
 * phase file. The deployment binding travels in the child environment
 * (see `importEnv`), never in argv: `--admin-key` on the command line is
 * visible to any local process-list reader for the import's duration, and
 * Node embeds the full argv in exec-failure messages that land in logs.
 * Extracted so the flag shape is unit-testable without a live deployment
 * -- the subprocess call itself cannot be.
 */
export function importArgs(table: string, file: string): string[] {
	// No --replace, ever: imports require empty tables, so a concurrent
	// writer (or a rerun without reset) fails loudly instead of silently
	// deleting live rows. See the module header.
	return ["convex", "import", "--table", table, "--yes", file];
}

/**
 * Explicit child-process environment for one `npx convex import`: the
 * self-hosted URL and admin key ride as `CONVEX_SELF_HOSTED_URL` /
 * `CONVEX_SELF_HOSTED_ADMIN_KEY` (the Convex CLI's documented env
 * alternative to `--url`/`--admin-key`), and `CONVEX_DEPLOYMENT` is
 * removed so the CLI cannot resolve a different deployment than the
 * reads use. Takes the parent env as its base so PATH and friends
 * survive; callers pass a stub env in tests.
 */
export function importEnv(
	target: ImportTarget,
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...baseEnv,
		CONVEX_SELF_HOSTED_URL: target.url,
		CONVEX_SELF_HOSTED_ADMIN_KEY: target.adminKey,
	};
	delete env["CONVEX_DEPLOYMENT"];
	return env;
}

/** Strips the admin key from text about to hit stderr/CI logs. */
export function redactSecrets(message: string, target: ImportTarget): string {
	// An empty key would split every character and balloon the message;
	// resolveImportTarget already rejects empty keys, so this is unreachable
	// defense for any future direct caller.
	if (target.adminKey.length === 0) return message;
	return message.split(target.adminKey).join("[redacted-admin-key]");
}

export async function runConvexImport(
	table: string,
	rows: Record<string, unknown>[],
	target: ImportTarget,
	deps: ImportRunnerDeps = {},
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "proof-vehicle-load-"));
	const file = join(dir, `${table}.jsonl`);
	try {
		writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
		const args = importArgs(table, file);
		await runImportChild(args, importEnv(target), table, deps);
	} catch (error) {
		throw new Error(
			redactSecrets(error instanceof Error ? error.message : String(error), target),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Process-group kill (negative-pid SIGKILL) works on POSIX only; the
 * watchdog falls back to plain child.kill on win32. Read once: the loader
 * never changes platform mid-run.
 */
const KILL_PROCESS_GROUP = process.platform !== "win32";

/** Test seams for runImportChild/runConvexImport (real spawn/kill/timers by default). */
export interface ImportRunnerDeps {
	spawnChild?: SpawnChildFn;
	killTree?: (pid: number, signal: NodeJS.Signals) => void;
	raiseSelf?: (signal: NodeJS.Signals) => void;
	timeoutMs?: number;
}

const defaultKillTree = (pid: number, signal: NodeJS.Signals): void => {
	process.kill(pid, signal);
};

/**
 * Runs one `npx convex import` child with a watchdog. A stalled
 * subprocess (network partition, stalled npx resolution, an interactive
 * prompt this non-interactive caller can't answer) must not block the
 * loader indefinitely -- and the watchdog must kill the whole process
 * tree, not just the direct `npx` shim: npm launches the real `convex`
 * CLI as a grandchild that would otherwise survive the timeout and keep
 * writing underneath a retry. `detached` makes the child a process-group
 * leader (POSIX) so a negative-pid SIGKILL takes the group with it.
 *
 * Operator abort (Ctrl-C / SIGTERM) is forwarded to the tree too: without
 * forwarding, killing only the loader orphans a detached import that keeps
 * writing after the operator stopped the run. Forwarders live only for the
 * child's lifetime and are removed on every settle path.
 */
export function runImportChild(
	args: string[],
	env: NodeJS.ProcessEnv,
	table: string,
	deps: ImportRunnerDeps = {},
): Promise<void> {
	const {
		spawnChild = spawn,
		killTree = defaultKillTree,
		raiseSelf = (signal: NodeJS.Signals) => process.kill(process.pid, signal),
		timeoutMs = 120_000,
	} = deps;
	const { promise: done, resolve, reject } = Promise.withResolvers<void>();
	const child = spawnChild("npx", args, {
		stdio: "inherit",
		env,
		detached: KILL_PROCESS_GROUP,
	});
	const killWholeTree = (): void => {
		if (KILL_PROCESS_GROUP && child.pid !== undefined) {
			try {
				killTree(-child.pid, "SIGKILL");
			} catch {
				// Group already gone; the exit handler below settles this.
			}
		} else {
			child.kill("SIGKILL");
		}
	};
	const abortSignals = ["SIGINT", "SIGTERM"] as const;
	// Bind the signal name explicitly: the runtime invokes these listeners
	// with no arguments, so a shared (signal) => ... handler would forward
	// undefined instead of re-raising the received signal.
	const forwarders = abortSignals.map((signal) => {
		const forward = (): void => {
			killWholeTree();
			raiseSelf(signal);
		};
		process.once(signal, forward);
		return { signal, forward };
	});
	const settle = (fn: () => void): void => {
		for (const { signal, forward } of forwarders) process.removeListener(signal, forward);
		fn();
	};
	const timer = setTimeout(() => {
		killWholeTree();
		settle(() => reject(new Error(`convex import timed out after ${timeoutMs}ms for ${table}`)));
	}, timeoutMs);
	child.on("error", (error) => {
		clearTimeout(timer);
		settle(() => reject(error));
	});
	child.on("exit", (code, signal) => {
		clearTimeout(timer);
		if (code === 0) settle(resolve);
		else settle(() => reject(new Error(`convex import ${signal ?? `exited ${code}`} for ${table}`)));
	});
	return done;
}

/**
 * A natural key for each table's ops, unique enough within one vector's
 * base state to bind a read-back row to its corpus label: rooms/users by
 * `name`, messages by `body` (the corpus never repeats a body within one
 * vector), and memberships/likes by their foreign-key pair (the shared
 * contract guarantees at most one membership per (room, user); no corpus
 * vector's *base* state repeats a (message, user) like pair, even though
 * V6's delta later adds a second one via a mutation call that returns its
 * own id directly, needing no read-back). Field layout comes from the
 * shared table (`basePlan.naturalKey`); this wrapper only resolves op
 * labels to ids first.
 */
export function naturalKey(op: BaseOp, idByLabel: ReadonlyMap<string, string>): string {
	const resolve = (label: string) => idByLabel.get(label) ?? label;
	const table = tableForOp(op);
	switch (op.op) {
		case "insertRoom":
		case "insertUser":
			return sharedNaturalKey(table, () => op.name);
		case "insertMessage":
			return sharedNaturalKey(table, () => op.body);
		case "insertMembership":
			return sharedNaturalKey(table, (field) =>
				resolve(field === "room" ? op.room : op.user),
			);
		case "insertLike":
			return sharedNaturalKey(table, (field) =>
				resolve(field === "message" ? op.message : op.user),
			);
	}
}

function rowNaturalKey(table: Phase["table"], row: Record<string, unknown>): string {
	return sharedNaturalKey(table, (field) => String(row[field]));
}

/**
 * Indexes one phase's read-back rows by natural key, failing loudly on a
 * duplicate: without this, two rows sharing a name/body silently collapse
 * in the Map and every label bound afterwards can point at the wrong row.
 * Extracted pure so the corpus-lint companion (uniqueness of *base* ops)
 * has a runtime twin for what the deployment actually returns.
 */
export function indexRowsByNaturalKey(
	table: Phase["table"],
	rows: readonly (Record<string, unknown> & { _id: string })[],
): Map<string, string> {
	const idByNaturalKey = new Map<string, string>();
	for (const row of rows) {
		const key = rowNaturalKey(table, row);
		const clash = idByNaturalKey.get(key);
		if (clash !== undefined) {
			throw new Error(
				`readBackLabels: duplicate ${table} rows share natural key "${key}" (${clash}, ${row._id}); ` +
					"labels cannot bind unambiguously",
			);
		}
		idByNaturalKey.set(key, row._id);
	}
	return idByNaturalKey;
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
	const rows = await withDeadline(
		client.query(ref, {}),
		60_000,
		`readBackLabels(${phase.table})`,
	);
	const idByNaturalKey = indexRowsByNaturalKey(phase.table, rows);
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

/**
 * Races a deployment read against a fixed clock: a hung backend must fail
 * this loader loudly (naming the read) instead of hanging the CLI forever.
 * Settles the timer on either outcome, so a resolved read leaves nothing
 * behind; a read that rejects after the timeout already fired settles
 * nothing further, avoiding unhandled rejections.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise: gated, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	promise.then(
		(value) => {
			clearTimeout(timer);
			resolve(value);
		},
		(err) => {
			clearTimeout(timer);
			reject(err);
		},
	);
	return gated;
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

	const existingMessages = await withDeadline(
		client.query(
			makeFunctionReference<"query", Record<string, never>, Record<string, unknown>[]>(
				"proofVehicle/tables:messages",
			),
			{},
		),
		60_000,
		"tables:messages legacy-row preflight",
	);
	if (legacyMessagesPresent(existingMessages)) {
		throw new Error(
			"legacy-messages-present: this deployment has a pre-migration messages row " +
				"(missing `room`); use a fresh local deployment or clear `messages` first.",
		);
	}

	// Every table imports with require-empty semantics (no --replace
	// anywhere): any pre-existing row aborts the run before anything is
	// written. rooms/users are the SAME tables convex/chat.ts (the live
	// tutorial app) reads and writes -- running this loader against the
	// same deployment `npm run dev` uses would fail loudly instead of
	// silently deleting live data, without requiring the loader to know
	// which rows are "its own" (KTD8's schema has no proof-vehicle-specific
	// ownership marker to scope a narrower delete by). Only a fresh or
	// reset deployment loads cleanly.
	{
		// Independent preflight reads: fetch concurrently, then apply the
		// same guard predicate to the same keyed inputs.
		const [rooms, users, memberships, likes] = await Promise.all([
			withDeadline(
				client.query(
					makeFunctionReference<"query", Record<string, never>, unknown[]>(
						"proofVehicle/tables:rooms",
					),
					{},
				),
				60_000,
				"tables:rooms emptiness preflight",
			),
			withDeadline(
				client.query(
					makeFunctionReference<"query", Record<string, never>, unknown[]>(
						"proofVehicle/tables:users",
					),
					{},
				),
				60_000,
				"tables:users emptiness preflight",
			),
			withDeadline(
				client.query(
					makeFunctionReference<"query", Record<string, never>, unknown[]>(
						"proofVehicle/tables:memberships",
					),
					{},
				),
				60_000,
				"tables:memberships emptiness preflight",
			),
			withDeadline(
				client.query(
					makeFunctionReference<"query", Record<string, never>, unknown[]>("proofVehicle/tables:likes"),
					{},
				),
				60_000,
				"tables:likes emptiness preflight",
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
					"Every table imports with require-empty semantics (no --replace anywhere), so loading " +
					"here would fail partway and leave a partial import. Use a fresh/disposable deployment, " +
					"or run `proofVehicle/fixture:reset` first and re-run.",
			);
		}
	}

	const vector = corpus.vectors[vectorId as keyof typeof corpus.vectors];
	const phases = planImportPhases(vector.base as BaseOp[]);
	const idByLabel = new Map<string, string>();

	for (const phase of phases) {
		// The preflight guard above is point-in-time and holds no lock across
		// this loop; without --replace, a concurrent write no longer gets
		// silently destroyed -- the require-empty import fails loudly
		// instead. Re-checking immediately before each phase (rather than
		// only once, before all five) still fails fast with a clear error
		// instead of a mid-loop import rejection.
		const rows = await withDeadline(
			client.query(
				makeFunctionReference<"query", Record<string, never>, unknown[]>(
					`proofVehicle/tables:${phase.table}`,
				),
				{},
			),
			60_000,
			`tables:${phase.table} pre-import recheck`,
		);
		if (rows.length > 0) {
			throw new Error(
				`non-empty-target: ${phase.table} gained rows after the initial preflight check ` +
					"(likely live traffic during this run). Refusing to import into it. Re-run after " +
					"confirming the deployment is quiesced.",
			);
		}
		const rowsToImport = buildImportRows(phase, idByLabel);
		await runConvexImport(phase.table, rowsToImport, target);
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
