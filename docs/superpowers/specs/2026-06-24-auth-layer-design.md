# Sapling Context Store — Auth Layer (v2) Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming) — ready for implementation plan
**Builds on:** the shipped v1 (one Worker, Hono, stateless `createMcpHandler` at `/mcp`, `shared/` as the only shared layer, D1, non-destructive staged writes, the vocab gate routing to `needs_triage`).

**Do not rescaffold or change the v1 architecture.** Add auth as its own module (`src/auth/`) and wire it in at the edge.

## 1. Purpose

The store keys on **who did what**, so identity must not be self-declared. This layer
authenticates both surfaces against a single identity provider (GitHub), authorizes
only members of the `SaplingLearn` org, gates all reads and writes, and derives
`author`/`created_by` from the authenticated principal — overwriting the payload's
advisory `session.author`.

## 2. Verified library/API facts (checked against installed versions + current docs, not memory)

- **Hono 4.12.27** — cookie helpers present (`getCookie`/`setCookie`/`deleteCookie`, and `setSignedCookie`/`getSignedCookie(c, name, value, secret, opt)`).
- **zod 4.x**, `@modelcontextprotocol/sdk ^1.29`, `agents ^0.16.2`, `@cloudflare/vitest-pool-workers ^0.16`, wrangler ^4.84 — unchanged from v1.
- **No OAuth library installed** → the GitHub flow is hand-rolled with `fetch` + Web Crypto (`crypto.subtle.digest`, `crypto.getRandomValues`). Decision: hand-roll (no new dependency).
- **GitHub OAuth web flow supports PKCE** (current docs): authorize `GET https://github.com/login/oauth/authorize` accepts `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`; token `POST https://github.com/login/oauth/access_token` accepts `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier` and returns JSON with `Accept: application/json`.
- **Org membership:** `GET https://api.github.com/user/memberships/orgs/SaplingLearn` with the user's token → `200` + `state: "active"|"pending"` for members, `404` otherwise. Requires `read:org`. We request `read:org read:user` (so `GET /user` reliably yields `name`).
- **MCP gotcha verified:** `createMcpHandler` (`node_modules/agents/dist/mcp/index.js`) emits no `.well-known`/`WWW-Authenticate`/Protected-Resource-Metadata; those references exist only in the MCP *client* code. Gating `/mcp` at the edge with a bare 401 and registering no discovery routes fully avoids OAuth advertisement.

If any installed API later differs from the above, flag it during implementation and bind to the installed reality.

## 3. Identity model (fixed)

- Single IdP: **GitHub**, for both surfaces.
- Authorization: **allow only active members of the `SaplingLearn` org**. No roles, no RBAC.
- **Gate reads and writes.** The only public routes are the auth routes used to log in (`/auth/login`, `/auth/callback`).
- The server derives `author`/`created_by` from the authenticated principal. `payload.session.author` is **advisory only and overwritten server-side**.

## 4. Module layout (`src/auth/` — contained; nothing smeared into routes/consumer/mcp)

```
src/auth/
  crypto.ts      sha256Hex(input), randomToken(), PKCE { verifier, challenge(S256) },
                 hmacSeal(value, secret) / hmacUnseal(sealed, secret)  (HMAC-SHA256, base64url)
  github.ts      buildAuthorizeUrl(...), exchangeCode(...), getUser(token), isActiveOrgMember(token)
  session.ts     createSession(db, login) / getSessionUser(db, id) / deleteSession(db, id)
                 + sealed-cookie helpers (set/get/clear) using COOKIE_SECRET
  tokens.ts      mintToken(db, login) -> { raw } / resolveToken(db, raw) -> { login } | null
  principal.ts   type Principal = { login: string };
                 resolveSessionPrincipal(c) [cookie]; resolveBearerPrincipal(req, env) [bearer];
                 sessionGate Hono middleware
  routes.ts      the /auth Hono sub-app: login, callback, logout, mcp-token
```

`SAPLING_ORG = "SaplingLearn"` is a constant in `github.ts`.

Files changed outside `src/auth/`: `src/index.ts` (bearer gate for `/mcp`), `src/routes.ts`
(mount auth sub-app + session gate + pass principal to `consume`), `src/consumer.ts`
(principal arg, author derivation), `src/mcp.ts` (principal arg, drop `author` tool field),
`src/env.ts` (new secret bindings), `shared/contract.ts` (advisory comment),
`migrations/0003_auth.sql` (new), `test/apply-migrations.ts` (truncate new tables), tests.
**`src/tools/writes.ts` and `src/tools/reads.ts` are unchanged** — they already take
`author` as explicit data; only the supplier changes.

## 5. Gating model (one rule, fail closed)

- **Public:** `/auth/login`, `/auth/callback` only. The static shell stays served by the
  assets binding (public — it contains no data; logged-out / non-member are React screens,
  not Worker redirects).
- **Session-gated (cookie → session → user):** all data routes (`/ingest`, `/feed`,
  `/docs`, `/doc/:slug`, `/search`) and `/auth/logout`, `/auth/mcp-token`. One Hono
  `app.use("*")` middleware, registered first, exempts the two public auth paths; on no/expired
  session it returns `401 {"error":"unauthorized"}` — **no data, never an empty 200 or partial
  payload**. On success: `c.set("principal", { login })`.
- **Bearer-gated (`/mcp`):** resolved in `src/index.ts` before the Hono app. Missing/invalid
  bearer → **bare 401, no `WWW-Authenticate` header, no OAuth metadata, no discovery route**.
  Valid → `handleMcp(request, env, ctx, principal)`.
- HTTP routes accept the **cookie only**; `/mcp` accepts the **bearer only**.

## 6. Site flow (browser; OAuth authorization code + PKCE)

- `GET /auth/login`: generate `state` and PKCE `verifier`; `challenge = base64url(SHA-256(verifier))`;
  set a short-lived (10 min) **signed, HttpOnly** `oauth_tx` cookie carrying `state.verifier`;
  `302` to GitHub authorize with `client_id`, `redirect_uri = ${origin}/auth/callback`,
  `scope = "read:org read:user"`, `state`, `code_challenge`, `code_challenge_method = S256`.
- `GET /auth/callback`: read `code`, `state` from query; read+verify `oauth_tx`, split `state.verifier`;
  if `state` mismatch → `403`. Exchange `code` + `code_verifier` at the token endpoint
  (`Accept: application/json`) → `access_token`. `getUser` → `{ login, name }`.
  `isActiveOrgMember(token)` → **non-member ⇒ `403`, no session**. Upsert `users`. Create a
  `sessions` row (random id, `created_at`, `expires_at = now + 30d`). Set the sealed `session`
  cookie (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age 30d). Clear `oauth_tx`. Redirect to `/`.
  Any exchange/identity error → `401/403`, no session.
- `POST /auth/logout`: delete the session row for the authenticated session; clear the cookie; `200`.

All GitHub `fetch` calls send a `User-Agent` header (GitHub requires it) and `Accept: application/vnd.github+json` for API calls.

## 7. MCP token (bearer; not a full OAuth provider)

- `POST /auth/mcp-token` (session-gated): generate `sapling_mcp_<base64url(32 random bytes)>`;
  store only `sha256hex(raw)` in `mcp_tokens` tied to the principal; return the raw token **once**
  as JSON `{ "token": "sapling_mcp_..." }`. The raw token is never stored.
- Claude Code sends it as `Authorization: Bearer <token>` (via `--header`). `resolveBearerPrincipal`
  hashes the presented token, looks up `token_hash WHERE revoked = 0`, resolves the owner as the
  principal, and updates `last_used_at`. Missing/unknown/revoked → null → bare 401.

## 8. Principal plumbing (boundary discipline preserved)

- Auth resolves at the **edge** (the session-gate middleware and the `/mcp` bearer check in
  `index.ts`); the principal flows downstream as **data**, never a global, never smeared into the
  protocol layer.
- `consume(db, payload, principal)`: every `author` / `created_by` / `source_author` comes from
  `principal.login`; `payload.session.author` is ignored.
- `handleMcp(request, env, ctx, principal)`: the `append_feed` and `propose_doc_update` tools drop
  their `author` input field and use `principal.login`. The MCP and HTTP adapters stay thin; the
  vocab gate remains the consumer's job and auth does not touch it.

## 9. D1 schema (`migrations/0003_auth.sql`)

```sql
CREATE TABLE users (
  github_login TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- random session id, stored in the cookie
  user TEXT NOT NULL REFERENCES users(github_login),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL REFERENCES users(github_login),
  token_hash TEXT NOT NULL UNIQUE,     -- sha-256 of the raw token, never the raw token
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
```

Row types for the three tables are added to `shared/rows.ts` (the only shared layer).

## 10. Env / secrets

`src/env.ts` gains (Wrangler secrets — not committed):
```ts
GITHUB_CLIENT_ID: string;
GITHUB_CLIENT_SECRET: string;
COOKIE_SECRET: string;
```
Documented in the README: set via `wrangler secret put <NAME>` for production and in a
git-ignored `.dev.vars` for local dev (alongside the existing `database_id` placeholder note).
The test env provides `COOKIE_SECRET` and dummy `GITHUB_*` via the vitest miniflare bindings.

## 11. `shared/contract.ts`

Mark `Session.author` advisory:
```ts
author: z.string(),   // advisory only — overwritten server-side from the authenticated principal
```
No structural change. The contract copy in the build prompt is updated to match so `shared/`
and the prompt stay identical.

## 12. Tests (added to the passing suite; vitest-pool-workers 0.16 setup kept)

`test/apply-migrations.ts` beforeEach truncate gains the new tables in FK-safe order
(`sessions`, `mcp_tokens` before `users`), still preserving the seeded vocab. Tests seed
`users` / `sessions` / `mcp_tokens` where needed.

1. **Unauthenticated write:** `POST /ingest` with no cookie and no bearer → `401`, and the `feed`
   row count is unchanged (nothing written).
2. **author override:** `consume(db, payload, { login: "real-user" })` where
   `payload.session.author = "someone-else"` stores `feed.author === "real-user"` (and
   `doc_versions.created_by === "real-user"`), not the claimed value.
3. **Bad bearer:** unknown and revoked tokens → `resolveBearerPrincipal` returns null, and
   `worker.fetch(/mcp, Authorization: Bearer <bad>)` → `401` with **no `WWW-Authenticate` header**.
4. **Good bearer:** a seeded user + token → `resolveBearerPrincipal` resolves `{ login: "real-user" }`
   and updates `last_used_at`.

## 13. Deferred (documented seams — do not build)

- The full GitHub-upstream OAuth provider for MCP (`workers-oauth-provider`) as the upgrade path
  from bearer tokens. The swap from bearer to the OAuth provider must touch only the `/mcp` edge and
  `resolveBearerPrincipal` — **never tool logic**.
- Token rotation / expiry, roles / RBAC, rate limiting.

## 14. Build order

1. `migrations/0003_auth.sql` + `shared/rows.ts` row types + `test/apply-migrations.ts` truncate.
2. The auth module primitives: `crypto.ts`, `github.ts`, `session.ts`, `tokens.ts`.
3. `principal.ts` (resolution + session-gate middleware) + `routes.ts` (auth endpoints incl. mint-token).
4. Thread the principal into `consumer.ts` and `mcp.ts`; switch author derivation off the payload;
   add `Env` fields; mount the auth sub-app + session gate in `routes.ts`.
5. The `/mcp` bearer check with the no-OAuth-advertisement bare 401 in `index.ts`.
6. Tests.

Keep auth in its own module; do not spread it across routes, consumer, or mcp.

## 15. Judgment calls (flagged)

- **Cookie signing uses our own HMAC-SHA256 seal** (`crypto.ts`, keyed by `COOKIE_SECRET`) rather
  than Hono's `setSignedCookie`, so tests can mint a valid cookie deterministically; cookie
  *attributes* still go through Hono's `setCookie`/`deleteCookie`. Functionally equivalent.
- **`Secure` is always set** (production-correct). Local *browser* testing of the cookie flow
  therefore needs https; the Vitest tests set `Cookie`/`Authorization` headers directly and are
  unaffected. (The real UI is deferred.)
- **Pending org invites do not count** — membership requires `state === "active"`.
- **OAuth transient state** (`state` + `verifier`) lives in a short-lived signed cookie, not a D1
  table — no new transient table.
