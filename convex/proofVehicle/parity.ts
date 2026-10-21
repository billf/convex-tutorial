/**
 * Parity hashing for the proof-vehicle oracle: a label-mapped,
 * deterministic summary of one table's rows, reproduced by Q's U8 parity
 * function against `corpus/v1.parity.json` / `testdata/v1.parity.json`.
 * Split out of `./fixture` so that module stays lifecycle + loading only.
 */

/** One table's golden base-state summary: row count plus a content hash. */
export type TableParity = { count: number; contentHash: string };

/** ID-shaped fields whose values map to corpus labels before hashing. */
const ID_LIKE_FIELDS: ReadonlySet<string> = new Set(["_id", "room", "user", "sender", "message"]);

/**
 * A label-mapped, deterministic hash of one table's rows: every `_id` and
 * foreign-key `Id` field is replaced by its corpus label (raw IDs always
 * differ between a deployment and convex-test), `_creationTime` is dropped
 * (it is real wall-clock time under convex-test and import-assigned time
 * on a deployment -- neither is reproducible across two independent
 * loads of the same vector, so it is not part of a table's identity for
 * parity purposes; the corpus's own declared creation times are instead
 * checked by the boundary/order tests), rows are sorted by their mapped
 * `_id` for order-independence, and the result is JSON with sorted object
 * keys, hashed with SHA-256. Reproduced by Q's U8 parity function against
 * `corpus/v1.parity.json` / `testdata/v1.parity.json`.
 */
export async function computeParity(
	rows: readonly Record<string, unknown>[],
	labelByRawId: ReadonlyMap<string, string>,
): Promise<TableParity> {
	const mapValue = (key: string, value: unknown): unknown => {
		if (ID_LIKE_FIELDS.has(key) && typeof value === "string") {
			return labelByRawId.get(value) ?? value;
		}
		return value;
	};
	const mapped = rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(row).sort()) {
			if (key === "_creationTime") continue;
			out[key] = mapValue(key, row[key]);
		}
		return out;
	});
	mapped.sort((a, b) => {
		const ai = String(a["_id"]);
		const bi = String(b["_id"]);
		return ai < bi ? -1 : ai > bi ? 1 : 0;
	});
	const canonical = JSON.stringify(mapped);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	const contentHash = [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return { count: rows.length, contentHash };
}

/** The hash algorithm ID recorded in `corpus/v1.parity.json` / `testdata/v1.parity.json`. */
export const PARITY_HASH_ALGORITHM = "sha256-json-sorted-keys-v1";
