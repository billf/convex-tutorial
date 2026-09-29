# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the [Convex tutorial](https://docs.convex.dev/tutorial) app: a small
realtime chat client (Vite + React) backed by Convex functions.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

That vendored output (`convex/_generated/ai/`, `.agents/skills/`,
`skills-lock.json`) is gitignored — run `npx convex ai-files install` if
`convex/_generated/ai/guidelines.md` is missing locally.

## Commands

- `npm run dev` — starts `convex dev` and the Vite dev server together (the
  normal way to run the app locally; requires a Convex deployment, i.e.
  `npx convex dev` has been set up once already).
- `npm run build` — type-checks with `tsc` then builds with `vite build`.
- `npm test` (or `npx vitest run`) — runs all tests once.
  - Single file: `npx vitest run src/App.test.tsx`
  - Watch mode: `npx vitest`
- Type-checking: **always use plain `npx tsc --noEmit -p .`** for a full
  project type-check, not Convex's own embedded typecheck. Convex typechecks
  `convex/**` against `convex/tsconfig.json`, a narrower config (no
  vitest/`convex-test` types) that's scoped to what Convex actually bundles
  and deploys — it will report false errors on `convex/*.test.ts`. The root
  `tsconfig.json` covers `src/`, `convex/`, and `vite.config.mts` together
  and is the correct one to check against during development.
- `npm run proof-vehicle-load <V1|V2|V3|V4|V5|V6>` — loads one corpus
  vector from `convex/proofVehicle/corpus/v1.json` into a real Convex
  deployment (see `scripts/proof-vehicle-load.ts`'s own header for
  required env vars). **Never point this at the deployment `npm run dev`
  uses** — it refuses to run against any deployment where
  rooms/users/memberships/messages/likes already has rows, specifically
  because rooms/users import with `--replace` and those are the same
  tables this app's own chat functions read and write.

## Architecture

**Backend (`convex/`)**: schema + server functions, deployed by Convex.
- `schema.ts` defines the shared proof-vehicle contract's five tables —
  `rooms` (`name`, indexed `by_name`), `users` (`name`, indexed `by_name`),
  `memberships` (`room`, `user`, `active`, indexed `by_room_user`),
  `messages` (`room`, `sender: v.id("users")`, `body`, indexed `by_room`
  and `by_sender`), `likes` (`message`, `user`, indexed `by_message`) —
  plus a harness-only `proofVehicleMarkers` table (a single sequence-number
  row a separate-session test source can poll). This replaced an earlier
  two-table `{messages, users}` schema; the migration is breaking (no
  backfill), which is fine for this tutorial's ephemeral data but should
  not be copied as a production migration pattern.
- `chat.ts` has the three functions the client calls, preserving that
  earlier `{user, body}` shape so `src/App.tsx` needs no change:
  - `getOrCreateUser` (mutation) — looks up a user by name via the
    `by_name` index, or inserts a new one. This is how a freshly-generated
    client display name becomes a real `users` row/id on first load.
  - `sendMessage` (mutation) — lazily creates (or finds) a single default
    room named `"general"` the first time it's called, ensures the sender
    has an active membership in it (so demo/test chat traffic populates
    demo/test memberships and stays visible to the proof-vehicle oracle
    below, matching production-shaped traffic's behavior), then inserts a
    message tied to that room and the given user id.
  - `getMessages` (query) — reads the latest 50 messages in the default
    room and resolves each message's sender name server-side (batched by
    unique user id, not a per-row lookup) so the client never needs its
    own join; returns `[]` before any message has ever been sent (the
    default room doesn't exist yet, and a query can't create it).
  - All three declare explicit `returns` validators, following the
    project's Convex guideline of always validating both `args` and
    `returns`.
- `convex/proofVehicle/` is a separate, isolated namespace implementing a
  correctness-oracle test harness on top of the same schema: `feed.ts` (the
  canonical room-feed query other implementations are checked against),
  `tables.ts` (plain per-table reads), `mutations.ts` (ten deterministic
  mutations), `fixture.ts` (marker sequence, guarded reset, shared patch
  logic), and `corpus/v1.json`/`v1.parity.json` (six hand-authored test
  vectors plus golden hashes). It shares `chat.ts`'s tables but not its
  code path; `sendMessage`'s membership write (above) keeps demo chat
  traffic visible to `proofVehicle/feed:roomFeed`'s active-membership
  filter. `scripts/proof-vehicle-load.ts` loads a corpus vector into a real
  deployment (see the Commands section above); it has not been run
  end-to-end in this environment.
- `_generated/` is Convex codegen (`api.d.ts`, `dataModel.d.ts`, server
  helpers) — regenerated automatically by `convex dev`; don't hand-edit it.
  `_generated/ai/` is the separate ai-files vendor output described above.
- `chat.test.ts` and `convex/proofVehicle/*.test.ts` use `convex-test` for
  hermetic backend tests against an in-memory Convex instance (no real
  deployment needed).

**Frontend (`src/`)**:
- `App.tsx` is the whole chat UI. On mount it resolves a per-session display
  name (`sessionStorage`, generated with `@faker-js/faker` if absent) into a
  real `Id<"users">` via `getOrCreateUser`, then uses that id for sending
  messages and for highlighting "your own" messages (`message.user ===
  userId`, an id comparison — not a name/string comparison).
- `main.tsx` wraps `<App />` in `ConvexProvider` and a top-level
  `ErrorBoundary` (`ErrorBoundary.tsx`), so a query/mutation failure during
  render shows a fallback instead of a blank screen.
- Frontend tests (`App.test.tsx`, `ErrorBoundary.test.tsx`) mock
  `convex/react`'s `useQuery`/`useMutation` and the generated `api` object
  directly (string-keyed stubs) rather than hitting a real backend, using
  `@testing-library/react`. They run under `// @vitest-environment jsdom`
  (per-file override), while backend tests in `convex/` run under the
  `edge-runtime` environment set in `vitest.config.ts`.

## Security notice

This tutorial's Convex functions are intentionally open: any connected
client can read/write the shared example data, and `sendMessage` /
`getOrCreateUser` accept a caller-supplied name/user id rather than deriving
identity from real auth. This is deliberate for keeping the tutorial
focused on data flow — do not treat it as a template for an authorization
model. A production app should add authentication and derive the caller's
identity server-side (`ctx.auth.getUserIdentity()`) instead of trusting
client-supplied ids.
