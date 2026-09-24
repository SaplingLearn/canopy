# Artifacts — implementation plan (issue #52)

Status: in build (2026-09-24). Feature branch: `feat/artifacts-ui`. One PR per track into it.

## Sources of truth

1. **The prototype** — Claude Design project `94e33d41-7fba-4268-9696-d5d247bd5158`, file
   `Canopy Artifacts.dc.html` (+ `artifacts-data.js`). A decoded copy is committed at
   `docs/superpowers/specs/artifacts-prototype/` (read it there; the sample data module is transcribed in `web/src/artifacts-sample.ts`).
   Every screen, state, label and rule in it is decided. **UI disagreement → the prototype wins.**
2. **The issue prompt** (this doc restates it). **Security or data disagreement → this doc wins.**
   The prototype covers text kinds only; this doc adds `image`, `pdf`, `file`.
3. **`shared/artifacts-core.ts`** — the contract every track codes against: kinds, caps, status
   rules, wire DTOs, `parseSlugVersion`. Change it only with a note under "Contract changes" below.

The UI-only port already on `feat/artifacts-ui` (`web/src/artifacts.ts`, `artifacts-sample.ts`,
routes in `web/src/hash.ts`, the sidebar entry, `test/render.artifacts.test.ts`) is Track D's
starting point, not throwaway.

## What the repo already has (read before building)

- **One Worker** (`src/index.ts`): `/mcp` (bearer), `/webhook/github` (HMAC), `/u/` (signed token),
  then the Hono app (`src/routes.ts`) where `app.use("*", sessionGate)` gates EVERYTHING.
  → A token-authenticated route (the upload PUT) must be dispatched in `src/index.ts` BEFORE
  `app.fetch`, exactly like `/u/`. `/raw/a/*` is session-gated, so it lives in the Hono app.
- **Principals**: `{ handle }` from the session cookie or the bearer (`src/auth/principal.ts`).
  Persons are keyed by handle; every handle column must be added to `HANDLE_COLUMNS`
  (`src/auth/persons.ts`) or a rename orphans it.
- **Human confirm gate** = session-cookie routes that are NEVER MCP tools (`/doc/:slug/promote`,
  `/adr/:id/ratify`). Ratify an artifact the same way.
- **FTS**: standalone FTS5 tables + triggers (`0008`/`0011`, `0013_roadmap_fts`, `tickets_fts` in
  `0024`); `query()` in `src/tools/reads.ts` ranks with `bm25(<t>, 1.0, 5.0, …)` (title weight 5).
  `query()` takes NO principal today.
- **Tickets and sprints exist**: `tickets` (0024), `sprints` (0025; ids are integers). Links store
  their ids as strings.
- **Migrations**: `0027_repo_capture` is the last on `main`. **`0028` is taken** by the other
  in-flight branch (`feat/handoffs-prompts-ui`, `0028_handoffs_prompts.sql`). Artifacts use
  **`0029_artifacts.sql`**. Test reset list: `scripts/seed/reset.mjs`.
- **Tests**: Vitest on a real Miniflare D1 (`vitest.config.ts` reads `wrangler.toml`, so an
  `[[r2_buckets]]` binding appears in tests as a local R2). GitHub/network is injected, never hit.
- No `AGENTS.md` exists yet. Skills live in `plugins/canopy/skills/` (symlinked from `.claude/skills/`).
- The SPA has no CSP of its own (no meta, no header) and no mermaid renderer.

## Decisions taken here (not in the prompt)

- **Tables** `artifact_pages`, `artifact_versions`, `artifact_links`, plus `artifact_upload_tokens`
  and `artifacts_fts`. `author_id`, `ratified_by`, `created_by`, token `principal` are person
  handles → `HANDLE_COLUMNS`.
- **A page with `current_version = 0` does not exist** to any reader (list, get, raw, query, MCP):
  it is a binary page created by an MCP call whose upload has not landed. Same 404 as a missing slug.
- **Binary uploads declare `sha256`** (hex) with `size_bytes`. The PUT streams through
  `FixedLengthStream(size_bytes)` into R2 at `artifacts/<sha256>` with R2's `sha256` put option, so
  R2 itself rejects a body that does not hash to it — no temp key, no second write. The MCP tools
  gain a `sha256` arg for binary kinds (the curl example computes it with `shasum -a 256`).
- **Who may write**: anyone who can READ a page may add a version, change status draft⇄published,
  change title/area/repo, and link/unlink (the prototype shows teammates versioning each other's
  pages). Only the **author** may set `visibility = private`. Ratify: any signed-in person, session
  only. A private page is readable (and so writable) only by its author.
- **404 parity**: missing slug, private-to-someone-else, and `current_version = 0` return the SAME
  status and body — `404 { "error": "not_found" }` over HTTP, `{ error: "not_found", code:
  "not_found" }` over MCP. Tested byte for byte.
- **Link refs**: `ticket` → ticket id, `sprint` → sprint id, `pr` / `issue` → `<owner>/<repo>#<n>`
  (a bare `#n` or number from a client is resolved against the page's `repo`). Tickets/sprints must
  exist at link time (400 otherwise).
- **FTS "description"** = the latest version's `summary` (pages have no description column).
  Extracted text: html/svg tags stripped, markdown/mermaid raw, binary nothing.
- **query authority**: `draft` → `"draft"`; `published` / `ratified` → `"live"`, and the hydrated
  body's first line states `Status: <status> · v<n>` so an agent can tell ratified from not.
  Private pages appear only to their author (query gains an optional `principal`).
- **MCP tool names** follow the codebase's snake_case: `artifact_create`, `artifact_update`,
  `artifact_get` (the prompt wrote `artifact-create` etc.).
- **Version addressing**: `slug@v3` and `slug/v3` accepted everywhere a version is parsed
  (`parseSlugVersion`): raw route, API, MCP, and the SPA hash (`#artifacts/<slug>/v3` canonical,
  `#artifacts/<slug>@v3` accepted).
- **Inline SVG is sanitized.** The prompt says "svg inline" in the viewer; inlining an uploaded SVG
  into the app origin unsanitized is XSS. The SPA inlines it only after
  `DOMPurify.sanitize(src, { USE_PROFILES: { svg: true, svgFilters: true } })`.
- **SSRF guard limit**: Workers cannot resolve DNS before `fetch`, so the guard blocks literal
  private/loopback/link-local IPs, `localhost`, `*.local`, `*.internal`, non-https, and re-checks
  every redirect hop itself (`redirect: "manual"`, ≤3 hops). DNS-rebinding to a private IP is not
  closable from a Worker; Cloudflare's egress does not reach RFC1918 space, which is the backstop.

## Track A — data layer (branch `feat/artifacts-a`)

Files: `migrations/0029_artifacts.sql`, `src/tools/artifacts.ts` (repository), `shared/artifacts.ts`
(zod request schemas; re-exports core), `src/env.ts` (`ARTIFACTS_BUCKET: R2Bucket`), `test/env.d.ts`,
`wrangler.toml`, `scripts/seed/reset.mjs`, `src/auth/persons.ts` (HANDLE_COLUMNS), `test/artifacts.repo.test.ts`.

- `wrangler.toml`: `[[r2_buckets]] binding = "ARTIFACTS_BUCKET"`, `bucket_name = "canopy-artifacts"`.
  (Owner step before any prod deploy: `wrangler r2 bucket create canopy-artifacts`.)
- Migration: the four tables with CHECKs matching `artifacts-core.ts`; `artifact_versions` has
  `CHECK ((content IS NULL) <> (r2_key IS NULL))` and `UNIQUE(page_id, version_no)`;
  `artifact_links` `UNIQUE(page_id, target_type, target_ref)`; `artifact_upload_tokens (token_hash
  PK, principal, page_id, kind, size_bytes, sha256, content_type, filename, summary, expires_at,
  used_at, created_at)`; `artifacts_fts(page_id UNINDEXED, title, description, body)` kept in sync
  by the repository (not triggers — the body needs tag stripping), bm25 `(1.0, 5.0, 1.0, 1.0)`.
- Repository (all take `db`, and `bucket` where binary; all throw `ArtifactError(code)` with codes
  `not_found | forbidden | bad_request | conflict | too_large | gone`, mapped to 404/403/400/409/413/410):
  `slugify`, `uniqueSlug`, `createPage`, `addTextVersion` (full content OR `old_str`/`new_str`, the
  old string must occur exactly once), `addBinaryVersion` (bytes in hand — HTTP multipart),
  `mintUploadToken` / `consumeUploadToken` (stream → R2 → finalize; single use, 5 min, 410 on
  expired/used), `patchPage`, `setStatus`, `ratify`, `addLink` / `removeLink`, `listPages(filters,
  viewer)`, `getPage(slug, version, viewer)`, `getVersionPair`, `readRaw(slug, version, viewer)`,
  `searchArtifacts(q, viewer)` for `query`. Rules in `artifacts-core.ts` (caps, sha no-op: an
  identical sha256 to the CURRENT version writes nothing and returns `{ unchanged: true }`).

## Track B — HTTP API + raw route (branch `feat/artifacts-b`, after A)

Files: `src/artifacts/routes.ts` (a Hono sub-app mounted at `/api/artifacts` in `src/routes.ts`),
`src/artifacts/raw.ts` (`/raw/a/*` in the app), `src/artifacts/upload.ts` (the token PUT, dispatched
from `src/index.ts`), `src/artifacts/fetch-url.ts` (SSRF-guarded fetch), `test/artifacts.http.test.ts`.

Routes (all session-cookie except the PUT):
`GET /api/artifacts?area&kind&author&status&sprint&ticket&q` → `{ artifacts: ArtifactSummaryDTO[] }`
sorted by `updated_at` desc · `GET /api/artifacts/:slug[?v=n]` → `ArtifactDetailDTO` ·
`POST /api/artifacts` (JSON text kinds; multipart `file` + fields for binary) → detail ·
`PATCH /api/artifacts/:slug` {title?, area?, repo?, visibility?, status? (draft|published)} ·
`POST /api/artifacts/:slug/versions` (JSON {content | old_str+new_str, summary}; multipart for binary) ·
`POST /api/artifacts/:slug/links` {target_type, target_ref} · `POST /api/artifacts/:slug/links/remove` ·
`GET /api/artifacts/:slug/diff?a=&b=` → `ArtifactDiffDTO` · `POST /api/artifacts/:slug/ratify {version}` ·
`POST /api/artifacts/fetch {url}` → `ArtifactFetchDTO` (https only, SSRF guard, 5 s, 500 KB read cap,
returns without storing) · `POST /api/artifacts/upload-url {slug?|new-page fields, kind, size_bytes,
sha256, content_type, filename, summary}` → `ArtifactUploadTicketDTO` · `PUT /api/artifacts/upload/:token`
(no cookie; the token IS the auth) → 200 detail / 410 / 413 / 400.
Raw: `GET /raw/a/:slug`, `/raw/a/:slug@v:n`, `/raw/a/:slug/v:n` — headers exactly as the prompt:
CSP (html/svg vs image/pdf/file), `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
`Cache-Control: private`, `Content-Disposition` inline/attachment, `?download=1` → attachment
`<slug>-v<n>.<ext>`; html gets the height `postMessage` script injected before `</body>` (appended if absent).

## Track C — MCP, query, skills (branch `feat/artifacts-c`, after A)

Files: `src/mcp.ts` (three tools), `src/tools/artifacts-agent.ts`, `src/tools/reads.ts` (`artifact`
query type, principal-aware), the record_session path (`shared/contract.ts` + consumer or a post-batch
step: `artifact_links: [{ slug, target_type, target_ref }]`, each through `addLink` with the principal's
read check), `plugins/canopy/skills/canopy/SKILL.md` (+ `references/querying.md`),
`plugins/canopy/skills/load-context/SKILL.md` (artifacts linked to the ticket it loads — via
`get_ticket` gaining `artifacts: [{slug,title,kind,status,version}]` for pages the principal can see),
`plugins/canopy/skills/record-session/SKILL.md`, `docs/artifact-contract.md`, `AGENTS.md` (new),
`test/artifacts.mcp.test.ts`. No ratify tool. Warn (a `warnings` array), never reject, on
`CLAUDE_ONLY_MARKERS`.

## Track D — SPA (branch `feat/artifacts-d`, parallel with A)

Files: `web/src/artifacts.ts`, `web/src/artifacts-sample.ts` (delete when API-backed, or keep only as
test fixtures), `web/src/api.ts` (artifact calls), `web/src/main.ts`, `web/src/render.ts`,
`web/src/hash.ts`, `web/src/tickets.ts`, `web/src/canopy.css`, `test/render.artifacts.test.ts`,
`test/hash.test.ts`. Code against the DTOs in `shared/artifacts-core.ts` and the routes above.
Everything in the prompt's Track D list, plus: kind picker gains image/pdf/file; file tab infers the
kind and shows the 10 MB cap for binary; paste/URL are text-only; html via `<iframe src="/raw/a/…"
sandbox="allow-scripts">` sized from `canopy:height` (check `e.source === iframe.contentWindow`),
NEVER srcdoc, NEVER allow-same-origin; svg inline (sanitized, above); mermaid via CDN dynamic import
as the prototype does (jsdelivr, `mermaid@11`); image `<img>`; pdf `<iframe sandbox="">`; file card +
Download. Thumbnails, diff per kind, open-in-tab/download → raw route. Themes light/dark/midnight.
Corner radii follow the app's `--corner-scale` rule (see CLAUDE.md "Corners").

## Track E — cross-cutting tests (branch `feat/artifacts-e`, after B and C)

`test/artifacts.security.test.ts` and friends: per-kind caps, hash no-op, slug collision, status
transitions, ratify gating (session only; not latest → 409; draft → 409; MCP has no path), private 404
parity (HTTP, raw, MCP, query), raw headers per kind, R2 streaming round-trip, upload token single use
+ expiry (410), SSRF guard table, MCP permission checks.

## Integration (orchestrator)

Merge A → D → B → C → E into `feat/artifacts-ui`; `npm test`, `npm run typecheck`, `npm run build:web`;
walk the SPA against the prototype screen by screen; update CLAUDE.md; then (after the owner's
review) update issue #52. Deferred on purpose: external share links, per-person sharing, a raw-content
subdomain, PDF text extraction for search.

## Contract changes / cross-track notes

(Any track that changes a file owned by another track, or `shared/artifacts-core.ts`, adds a dated
line here saying what and why.)
