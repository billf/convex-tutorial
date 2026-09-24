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

## Architecture

**Backend (`convex/`)**: schema + server functions, deployed by Convex.
- `schema.ts` defines two tables: `messages` (`user: v.id("users")`, `body`,
  indexed `by_user`) and `users` (`name`, indexed `by_name`). Messages store
  a reference to a user document, not a raw display-name string.
- `chat.ts` has the three functions the client calls:
  - `getOrCreateUser` (mutation) — looks up a user by name via the
    `by_name` index, or inserts a new one. This is how a freshly-generated
    client display name becomes a real `users` row/id on first load.
  - `sendMessage` (mutation) — inserts a message tied to a `users` id.
  - `getMessages` (query) — reads the latest 50 messages and resolves each
    message's sender name server-side (batched by unique user id, not a
    per-row lookup) so the client never needs its own join.
  - All three declare explicit `returns` validators, following the
    project's Convex guideline of always validating both `args` and
    `returns`.
- `_generated/` is Convex codegen (`api.d.ts`, `dataModel.d.ts`, server
  helpers) — regenerated automatically by `convex dev`; don't hand-edit it.
  `_generated/ai/` is the separate ai-files vendor output described above.
- `chat.test.ts` uses `convex-test` for hermetic backend tests against an
  in-memory Convex instance (no real deployment needed).

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
