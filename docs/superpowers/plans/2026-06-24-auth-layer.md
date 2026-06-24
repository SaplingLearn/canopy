# Auth Layer (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub-OAuth auth layer to the shipped v1 context store: gate all reads/writes, authorize only `SaplingLearn` org members, authenticate the site by session cookie and `/mcp` by per-person bearer token, and derive `author`/`created_by` from the authenticated principal instead of the advisory payload `session.author`.

**Architecture:** Auth lives entirely in a new `src/auth/` module. The principal is resolved at the edge (a Hono session-gate middleware for HTTP, a bearer check in `index.ts` for `/mcp`) and flows downstream as a plain `{ login }` argument into `consume()` and `handleMcp()`. The v1 architecture (one Worker, Hono, stateless `createMcpHandler`, `shared/` as the only shared layer, D1, non-destructive staged writes, the vocab gate) is unchanged; `src/tools/*` is untouched.

**Tech Stack:** Cloudflare Workers, Hono 4.12 (cookie helpers), D1, TypeScript, hand-rolled GitHub OAuth (authorization code + PKCE) over `fetch` + Web Crypto, Vitest + `@cloudflare/vitest-pool-workers` 0.16.

## Global Constraints

Copy values verbatim; every task implicitly includes these.

- **Verify-before-binding:** do not assume library versions/APIs from memory. The verified set (this repo): Hono `4.12.27` (cookie helpers incl. `setCookie`/`getCookie`/`deleteCookie`), zod `4.x`, `@cloudflare/vitest-pool-workers ^0.16` (peers `vitest@^4.1`), wrangler `^4.84`. No OAuth library — hand-roll with `fetch` + Web Crypto (`crypto.subtle`, `crypto.getRandomValues`).
- **Single IdP:** GitHub. **Authorize only active members of `SaplingLearn`** (`state === "active"`). No roles/RBAC.
- **Gate reads and writes. Only `/auth/login` and `/auth/callback` are public.** The static shell stays asset-served (public, no data). Every gated route **fails closed: 401 with no data in the body, never an empty 200 or partial payload.**
- **`/mcp` is bearer-only.** On missing/invalid bearer return **401 with NO `WWW-Authenticate` header and NO OAuth discovery/metadata/`.well-known` route** (Claude Code falls back to OAuth discovery if both a header scheme and OAuth are advertised).
- **Identity is server-derived.** `author`/`created_by`/`source_author` come from the authenticated principal; `payload.session.author` is ignored.
- **Boundary discipline:** auth resolves at the edge; the principal flows as data, not a global, not smeared into the protocol layer. MCP/HTTP adapters stay thin. The vocab gate stays the consumer's job; auth does not touch it. Auth stays in `src/auth/`.
- **Secrets (Wrangler secrets, never committed):** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_SECRET`.
- **Tokens:** store only `sha256hex(rawToken)`, never the raw token. Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- **Tests:** keep the vitest-pool-workers 0.16 setup and the `beforeEach` truncate that preserves vocab; add the new tables to the truncate.
- **Deferred (seams only, do not build):** the full GitHub-upstream OAuth provider for MCP (`workers-oauth-provider`), token rotation/expiry, roles/RBAC, rate limiting. The bearer→OAuth swap must touch only the `/mcp` edge + `resolveBearerPrincipal`, never tool logic.

## Parallelization Map (for subagent-driven execution)

Disjoint file ownership per group; no worktrees needed.
- **Task 1** (substrate): sequential, blocks all.
- **Tasks 2 ∥ 3** (crypto ∥ github): parallel.
- **Tasks 4 ∥ 5** (session ∥ tokens): parallel (both depend on 2 + db).
- **Task 6** (principal): depends on 4 + 5.
- **Task 7** (auth routes): depends on 2,3,4,5,6.
- **Tasks 8 ∥ 9** (consumer ∥ mcp threading): parallel (both depend on 6's `Principal` type; different files).
- **Task 10** (index + routes wire-in): depends on 6,7,8,9.
- **Task 11** (docs + contract comment): independent (anytime after 1).
- **Task 12** (integration verify): last.

## File Structure

```
src/auth/
  crypto.ts      sha256Hex, randomToken, pkceChallenge, pkce, hmacSeal, hmacUnseal
  github.ts      SAPLING_ORG, buildAuthorizeUrl, exchangeCode, getUser, isActiveOrgMember
  session.ts     createSession, getSessionUser, deleteSession + sealed-cookie set/read/clear
  tokens.ts      mintToken, resolveToken
  principal.ts   Principal, AppEnv, resolveSessionPrincipal, resolveBearerPrincipal, sessionGate
  routes.ts      authApp (GET /login, GET /callback, POST /logout, POST /mcp-token)
src/env.ts        +GITHUB_CLIENT_ID, +GITHUB_CLIENT_SECRET, +COOKIE_SECRET
src/consumer.ts   consume(db, payload, principal) — author from principal
src/mcp.ts        handleMcp(req, env, ctx, principal) — write tools drop `author` field
src/routes.ts     mount authApp + sessionGate; pass principal to consume
src/index.ts      /mcp bearer gate (bare 401) → handleMcp(..., principal)
shared/rows.ts    +UserRow, +SessionRow, +McpTokenRow
shared/contract.ts session.author advisory comment
migrations/0003_auth.sql   users, sessions, mcp_tokens
test/apply-migrations.ts   truncate new tables
test/auth-*.test.ts        new tests
vitest.config.ts, test/env.d.ts   test secret bindings + typing
README.md, .dev.vars.example       secrets docs
```

---

## Task 1: Auth substrate (migration, row types, env, test wiring)

**Files:**
- Create: `migrations/0003_auth.sql`, `.dev.vars.example`
- Modify: `shared/rows.ts` (append three interfaces), `src/env.ts` (add 3 fields), `test/apply-migrations.ts` (truncate), `vitest.config.ts` (bindings), `test/env.d.ts` (augment)

**Interfaces:**
- Produces: D1 tables `users`, `sessions`, `mcp_tokens`; `UserRow`, `SessionRow`, `McpTokenRow`; `Env` with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_SECRET`; test env exposing those secrets.

- [ ] **Step 1: Create `migrations/0003_auth.sql`**

```sql
CREATE TABLE users (
  github_login TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL REFERENCES users(github_login),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL REFERENCES users(github_login),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user);
CREATE INDEX idx_mcp_tokens_user ON mcp_tokens(user);
```

- [ ] **Step 2: Append row types to `shared/rows.ts`**

```ts
export interface UserRow {
  github_login: string;
  name: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user: string;
  created_at: string;
  expires_at: string;
}

export interface McpTokenRow {
  id: number;
  user: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}
```

- [ ] **Step 3: Add secret fields to `src/env.ts`**

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_SECRET: string;
}
```

- [ ] **Step 4: Extend the `beforeEach` truncate in `test/apply-migrations.ts`**

Replace the single `env.DB.exec(...)` call's SQL string with (children before parents; vocab preserved):
```ts
  await env.DB.exec(
    "DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage; DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;"
  );
```

- [ ] **Step 5: Add test secret bindings in `vitest.config.ts`**

In the `miniflare.bindings` object, alongside `TEST_MIGRATIONS`, add:
```ts
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "migrations")
          ),
          COOKIE_SECRET: "test-cookie-secret",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
        },
```

- [ ] **Step 6: Augment `Cloudflare.Env` in `test/env.d.ts`**

Inside the `interface Env { ... }` block, add the three secret fields:
```ts
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      COOKIE_SECRET: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
    }
```

- [ ] **Step 7: Create `.dev.vars.example`**

```
# Local dev secrets for `wrangler dev` (copy to .dev.vars, which is git-ignored).
# In production set these with: wrangler secret put <NAME>
GITHUB_CLIENT_ID=your-oauth-app-client-id
GITHUB_CLIENT_SECRET=your-oauth-app-client-secret
COOKIE_SECRET=a-long-random-string
```

- [ ] **Step 8: Verify migrations apply and the suite is still green**

Run: `npx wrangler d1 migrations apply sapling-context --local`
Expected: reports migration `0003_auth.sql` applied with no error.
Run: `npx tsc -p tsconfig.worker.json` → exit 0.
Run: `npm test` → existing suite still passes (5/5; the new tables don't break anything).

- [ ] **Step 9: Commit**

```bash
git add migrations/0003_auth.sql shared/rows.ts src/env.ts test/apply-migrations.ts vitest.config.ts test/env.d.ts .dev.vars.example
git commit -m "feat(auth): add users/sessions/mcp_tokens schema, env secrets, test wiring"
```

---

## Task 2: Crypto helpers (`src/auth/crypto.ts`)

**Files:**
- Create: `src/auth/crypto.ts`
- Test: `test/auth-crypto.test.ts`

**Interfaces:**
- Consumes: Web Crypto globals only.
- Produces: `sha256Hex(input: string): Promise<string>`; `randomToken(bytes?: number): string`; `pkceChallenge(verifier: string): Promise<string>`; `pkce(): Promise<{ verifier: string; challenge: string }>`; `hmacSeal(value: string, secret: string): Promise<string>`; `hmacUnseal(sealed: string, secret: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

`test/auth-crypto.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sha256Hex, randomToken, pkceChallenge, hmacSeal, hmacUnseal } from "../src/auth/crypto";

describe("auth crypto", () => {
  it("sha256Hex matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("randomToken is url-safe and >= 43 chars for 32 bytes, and unique", () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(b);
  });

  it("pkceChallenge equals base64url(sha256(verifier))", async () => {
    const v = "test-verifier";
    const ch = await pkceChallenge(v);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(ch).toBe(expected);
  });

  it("hmacSeal/hmacUnseal round-trips and rejects tampering and wrong secret", async () => {
    const sealed = await hmacSeal("session-id-123", "secret");
    expect(await hmacUnseal(sealed, "secret")).toBe("session-id-123");
    expect(await hmacUnseal(sealed, "other-secret")).toBeNull();
    expect(await hmacUnseal(sealed + "x", "secret")).toBeNull();
    expect(await hmacUnseal("no-dot", "secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-crypto.test.ts`
Expected: FAIL — cannot resolve `../src/auth/crypto`.

- [ ] **Step 3: Write `src/auth/crypto.ts`**

```ts
// Web Crypto helpers for auth. No external dependencies.
const enc = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/** URL-safe random token with `bytes` of entropy (default 32 -> 43 base64url chars). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/** PKCE S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

/** A PKCE verifier (within the allowed charset) and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Seal a value as `value.sigBase64url` (HMAC-SHA256). The value must be dot-free for clean unsealing. */
export async function hmacSeal(value: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return `${value}.${toBase64Url(sig)}`;
}

/** Verify and open a sealed value; null if malformed, tampered, or signed with another secret. */
export async function hmacUnseal(sealed: string, secret: string): Promise<string | null> {
  const i = sealed.lastIndexOf(".");
  if (i < 0) return null;
  const value = sealed.slice(0, i);
  const expected = await hmacSeal(value, secret);
  return expected === sealed ? value : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/auth-crypto.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/crypto.ts test/auth-crypto.test.ts
git commit -m "feat(auth): add Web Crypto helpers (sha256, PKCE, HMAC seal)"
```

---

## Task 3: GitHub OAuth client (`src/auth/github.ts`)

**Files:**
- Create: `src/auth/github.ts`
- Test: `test/auth-github.test.ts`

**Interfaces:**
- Consumes: `Env` (`src/env.ts`), `fetch`.
- Produces: `SAPLING_ORG` (const `"SaplingLearn"`); `buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string }): string`; `exchangeCode(opts: { env: Env; code: string; redirectUri: string; verifier: string }): Promise<string | null>`; `getUser(token: string): Promise<{ login: string; name: string | null } | null>`; `isActiveOrgMember(token: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test** (pure URL builder; the `fetch` functions are exercised in the live integration task)

`test/auth-github.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, SAPLING_ORG } from "../src/auth/github";

describe("buildAuthorizeUrl", () => {
  it("targets GitHub authorize with client_id, redirect_uri, scope, state, and S256 challenge", () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/auth/callback", state: "st", challenge: "ch" })
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x/auth/callback");
    expect(url.searchParams.get("scope")).toBe("read:org read:user");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("pins the org constant", () => {
    expect(SAPLING_ORG).toBe("SaplingLearn");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-github.test.ts`
Expected: FAIL — cannot resolve `../src/auth/github`.

- [ ] **Step 3: Write `src/auth/github.ts`**

```ts
import type { Env } from "../env";

export const SAPLING_ORG = "SaplingLearn";
const USER_AGENT = "sapling-context";
const GH_API = "application/vnd.github+json";

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", "read:org read:user");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Exchange an authorization code (+ PKCE verifier) for an access token; null on failure. */
export async function exchangeCode(opts: {
  env: Env;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<string | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      client_id: opts.env.GITHUB_CLIENT_ID,
      client_secret: opts.env.GITHUB_CLIENT_SECRET,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/** The authenticated user's login + name; null on failure. */
export async function getUser(token: string): Promise<{ login: string; name: string | null } | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: GH_API, "user-agent": USER_AGENT },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { login?: string; name?: string | null };
  return data.login ? { login: data.login, name: data.name ?? null } : null;
}

/** True only if the token's owner is an ACTIVE member of SAPLING_ORG. */
export async function isActiveOrgMember(token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/user/memberships/orgs/${SAPLING_ORG}`, {
    headers: { authorization: `Bearer ${token}`, accept: GH_API, "user-agent": USER_AGENT },
  });
  if (!res.ok) return false; // 404 => not a member
  const data = (await res.json()) as { state?: string };
  return data.state === "active"; // a pending invite does not count
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/auth-github.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/github.ts test/auth-github.test.ts
git commit -m "feat(auth): add hand-rolled GitHub OAuth client + org-membership check"
```

---

## Task 4: Sessions (`src/auth/session.ts`)

**Files:**
- Create: `src/auth/session.ts`
- Test: `test/auth-session.test.ts`

**Interfaces:**
- Consumes: `hono/cookie` (`setCookie`, `getCookie`, `deleteCookie`), `src/db.ts` (`DB`, `first`, `run`), `src/auth/crypto.ts` (`randomToken`, `hmacSeal`, `hmacUnseal`), `hono` `Context`.
- Produces: `createSession(db: DB, login: string): Promise<{ id: string; expiresAt: string }>`; `getSessionUser(db: DB, id: string): Promise<string | null>`; `deleteSession(db: DB, id: string): Promise<void>`; `setSessionCookie(c: Context, id: string, secret: string): Promise<void>`; `readSessionCookie(c: Context, secret: string): Promise<string | null>`; `clearSessionCookie(c: Context): void`.

- [ ] **Step 1: Write the failing test**

`test/auth-session.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createSession, getSessionUser, deleteSession } from "../src/auth/session";
import { run } from "../src/db";

async function seedUser(login: string) {
  await env.DB.prepare(`INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`)
    .bind(login, login, "2026-01-01T00:00:00Z").run();
}

describe("sessions", () => {
  it("creates a session and resolves it to the user", async () => {
    await seedUser("real-user");
    const { id } = await createSession(env.DB, "real-user");
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(await getSessionUser(env.DB, id)).toBe("real-user");
  });

  it("returns null for an unknown session id", async () => {
    expect(await getSessionUser(env.DB, "nope")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    await seedUser("real-user");
    await run(env.DB,
      `INSERT INTO sessions (id, user, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      "expired-id", "real-user", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z");
    expect(await getSessionUser(env.DB, "expired-id")).toBeNull();
  });

  it("deletes a session (revocation)", async () => {
    await seedUser("real-user");
    const { id } = await createSession(env.DB, "real-user");
    await deleteSession(env.DB, id);
    expect(await getSessionUser(env.DB, id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-session.test.ts`
Expected: FAIL — cannot resolve `../src/auth/session`.

- [ ] **Step 3: Write `src/auth/session.ts`**

```ts
import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { type DB, first, run } from "../db";
import { randomToken, hmacSeal, hmacUnseal } from "./crypto";

const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(db: DB, login: string): Promise<{ id: string; expiresAt: string }> {
  const id = randomToken(32);
  const now = Date.now();
  const created_at = new Date(now).toISOString();
  const expires_at = new Date(now + SESSION_TTL_MS).toISOString();
  await run(db, `INSERT INTO sessions (id, user, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    id, login, created_at, expires_at);
  return { id, expiresAt: expires_at };
}

export async function getSessionUser(db: DB, id: string): Promise<string | null> {
  const row = await first<{ user: string; expires_at: string }>(
    db, `SELECT user, expires_at FROM sessions WHERE id = ?`, id);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.user;
}

export async function deleteSession(db: DB, id: string): Promise<void> {
  await run(db, `DELETE FROM sessions WHERE id = ?`, id);
}

export async function setSessionCookie(c: Context, id: string, secret: string): Promise<void> {
  setCookie(c, SESSION_COOKIE, await hmacSeal(id, secret), {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function readSessionCookie(c: Context, secret: string): Promise<string | null> {
  const sealed = getCookie(c, SESSION_COOKIE);
  return sealed ? hmacUnseal(sealed, secret) : null;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/auth-session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/session.ts test/auth-session.test.ts
git commit -m "feat(auth): add D1-backed sessions + sealed session cookie"
```

---

## Task 5: MCP tokens (`src/auth/tokens.ts`)

**Files:**
- Create: `src/auth/tokens.ts`
- Test: `test/auth-tokens.test.ts`

**Interfaces:**
- Consumes: `src/db.ts` (`DB`, `first`, `run`, `nowIso`), `src/auth/crypto.ts` (`randomToken`, `sha256Hex`).
- Produces: `mintToken(db: DB, login: string): Promise<{ raw: string }>`; `resolveToken(db: DB, raw: string): Promise<{ login: string } | null>`.

- [ ] **Step 1: Write the failing test**

`test/auth-tokens.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { mintToken, resolveToken } from "../src/auth/tokens";
import { first } from "../src/db";

async function seedUser(login: string) {
  await env.DB.prepare(`INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`)
    .bind(login, login, "2026-01-01T00:00:00Z").run();
}

describe("mcp tokens", () => {
  it("mints a prefixed token, stores only its hash, and resolves it to the owner (bumping last_used_at)", async () => {
    await seedUser("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    expect(raw.startsWith("sapling_mcp_")).toBe(true);

    expect(await resolveToken(env.DB, raw)).toEqual({ login: "real-user" });

    const row = await first<{ last_used_at: string | null; token_hash: string }>(
      env.DB, `SELECT last_used_at, token_hash FROM mcp_tokens WHERE user = ?`, "real-user");
    expect(row?.last_used_at).not.toBeNull();
    expect(row?.token_hash).not.toBe(raw); // never the raw token
  });

  it("rejects an unknown token", async () => {
    expect(await resolveToken(env.DB, "sapling_mcp_unknown")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    await seedUser("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    await env.DB.prepare(`UPDATE mcp_tokens SET revoked = 1 WHERE user = ?`).bind("real-user").run();
    expect(await resolveToken(env.DB, raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-tokens.test.ts`
Expected: FAIL — cannot resolve `../src/auth/tokens`.

- [ ] **Step 3: Write `src/auth/tokens.ts`**

```ts
import { type DB, first, run, nowIso } from "../db";
import { randomToken, sha256Hex } from "./crypto";

const TOKEN_PREFIX = "sapling_mcp_";

/** Mint a token: returns the raw token ONCE; stores only its SHA-256 hash. */
export async function mintToken(db: DB, login: string): Promise<{ raw: string }> {
  const raw = TOKEN_PREFIX + randomToken(32);
  const token_hash = await sha256Hex(raw);
  await run(db, `INSERT INTO mcp_tokens (user, token_hash, created_at) VALUES (?, ?, ?)`,
    login, token_hash, nowIso());
  return { raw };
}

/** Resolve a presented raw token to its owner; null if missing/unknown/revoked. Bumps last_used_at. */
export async function resolveToken(db: DB, raw: string): Promise<{ login: string } | null> {
  if (!raw) return null;
  const token_hash = await sha256Hex(raw);
  const row = await first<{ id: number; user: string }>(
    db, `SELECT id, user FROM mcp_tokens WHERE token_hash = ? AND revoked = 0`, token_hash);
  if (!row) return null;
  await run(db, `UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?`, nowIso(), row.id);
  return { login: row.user };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/auth-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/tokens.ts test/auth-tokens.test.ts
git commit -m "feat(auth): add MCP bearer tokens (hashed at rest)"
```

---

## Task 6: Principal resolution + session gate (`src/auth/principal.ts`)

**Files:**
- Create: `src/auth/principal.ts`
- Test: `test/auth-principal.test.ts`

**Interfaces:**
- Consumes: `hono` (`Context`, `MiddlewareHandler`), `src/env.ts` (`Env`), `src/auth/session.ts` (`readSessionCookie`, `getSessionUser`), `src/auth/tokens.ts` (`resolveToken`).
- Produces: `interface Principal { login: string }`; `type AppEnv = { Bindings: Env; Variables: { principal: Principal } }`; `resolveSessionPrincipal(c: Context<AppEnv>): Promise<Principal | null>`; `resolveBearerPrincipal(request: Request, env: Env): Promise<Principal | null>`; `sessionGate: MiddlewareHandler<AppEnv>`.

- [ ] **Step 1: Write the failing test** (covers required tests 3 + 4 at the resolution level)

`test/auth-principal.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { resolveBearerPrincipal } from "../src/auth/principal";
import { mintToken } from "../src/auth/tokens";

async function seedUser(login: string) {
  await env.DB.prepare(`INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`)
    .bind(login, login, "2026-01-01T00:00:00Z").run();
}
const req = (auth?: string) =>
  new Request("https://x/mcp", { method: "POST", headers: auth ? { authorization: auth } : {} });

describe("resolveBearerPrincipal", () => {
  it("resolves a valid bearer to the owner principal", async () => {
    await seedUser("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    expect(await resolveBearerPrincipal(req(`Bearer ${raw}`), env)).toEqual({ login: "real-user" });
  });

  it("returns null when the Authorization header is missing", async () => {
    expect(await resolveBearerPrincipal(req(), env)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveBearerPrincipal(req("Bearer sapling_mcp_unknown"), env)).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    await seedUser("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    await env.DB.prepare(`UPDATE mcp_tokens SET revoked = 1`).run();
    expect(await resolveBearerPrincipal(req(`Bearer ${raw}`), env)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-principal.test.ts`
Expected: FAIL — cannot resolve `../src/auth/principal`.

- [ ] **Step 3: Write `src/auth/principal.ts`**

```ts
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { readSessionCookie, getSessionUser } from "./session";
import { resolveToken } from "./tokens";

export interface Principal {
  login: string;
}

export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };

// The only routes reachable without a session. Everything else is gated.
const PUBLIC_PATHS = new Set(["/auth/login", "/auth/callback"]);

export async function resolveSessionPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (!id) return null;
  const login = await getSessionUser(c.env.DB, id);
  return login ? { login } : null;
}

export async function resolveBearerPrincipal(request: Request, env: Env): Promise<Principal | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  return resolveToken(env.DB, match[1]);
}

/**
 * Gate every route except the two public auth paths. Fails closed: 401 with no
 * data in the body. On success, sets the principal on the context for handlers.
 */
export const sessionGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();
  const principal = await resolveSessionPrincipal(c);
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  c.set("principal", principal);
  return next();
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/auth-principal.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/principal.ts test/auth-principal.test.ts
git commit -m "feat(auth): add edge principal resolution + session-gate middleware"
```

---

## Task 7: Auth routes (`src/auth/routes.ts`)

**Files:**
- Create: `src/auth/routes.ts`
- Test: `test/auth-routes.test.ts`

**Interfaces:**
- Consumes: `hono` (`Hono`), `hono/cookie` (`setCookie`, `getCookie`, `deleteCookie`), `src/auth/principal.ts` (`AppEnv`), `src/auth/crypto.ts` (`pkce`, `randomToken`, `hmacSeal`, `hmacUnseal`), `src/auth/github.ts` (`buildAuthorizeUrl`, `exchangeCode`, `getUser`, `isActiveOrgMember`), `src/auth/session.ts` (`createSession`, `setSessionCookie`, `readSessionCookie`, `deleteSession`, `clearSessionCookie`), `src/auth/tokens.ts` (`mintToken`), `src/db.ts` (`run`, `nowIso`).
- Produces: `authApp` (a `Hono<AppEnv>` with `GET /login`, `GET /callback`, `POST /logout`, `POST /mcp-token`), mounted at `/auth` by `src/routes.ts`.

- [ ] **Step 1: Write the failing test** (the login redirect is deterministic; callback hits GitHub and is covered by the live integration task)

`test/auth-routes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { authApp } from "../src/auth/routes";
import { env } from "cloudflare:test";

describe("GET /auth/login", () => {
  it("302-redirects to GitHub authorize with PKCE params and sets the oauth_tx cookie", async () => {
    const res = await authApp.request("/login", {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain("oauth_tx=");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-routes.test.ts`
Expected: FAIL — cannot resolve `../src/auth/routes`.

- [ ] **Step 3: Write `src/auth/routes.ts`**

```ts
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "./principal";
import { pkce, randomToken, hmacSeal, hmacUnseal } from "./crypto";
import { buildAuthorizeUrl, exchangeCode, getUser, isActiveOrgMember } from "./github";
import { createSession, setSessionCookie, readSessionCookie, deleteSession, clearSessionCookie } from "./session";
import { mintToken } from "./tokens";
import { run, nowIso } from "../db";

const OAUTH_TX_COOKIE = "oauth_tx";

export const authApp = new Hono<AppEnv>();

// PUBLIC: start the OAuth dance.
authApp.get("/login", async (c) => {
  const state = randomToken(16);
  const { verifier, challenge } = await pkce();
  const sealed = await hmacSeal(`${state}.${verifier}`, c.env.COOKIE_SECRET);
  setCookie(c, OAUTH_TX_COOKIE, sealed, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  const origin = new URL(c.req.url).origin;
  return c.redirect(
    buildAuthorizeUrl({ clientId: c.env.GITHUB_CLIENT_ID, redirectUri: `${origin}/auth/callback`, state, challenge }),
    302
  );
});

// PUBLIC: finish the OAuth dance; create a session only for active org members.
authApp.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const sealedTx = getCookie(c, OAUTH_TX_COOKIE);
  deleteCookie(c, OAUTH_TX_COOKIE, { path: "/" });
  if (!code || !state || !sealedTx) return c.json({ error: "invalid_request" }, 400);

  const tx = await hmacUnseal(sealedTx, c.env.COOKIE_SECRET);
  if (!tx) return c.json({ error: "bad_state" }, 403);
  const [txState, verifier] = tx.split(".");
  if (txState !== state) return c.json({ error: "state_mismatch" }, 403);

  const origin = new URL(c.req.url).origin;
  const token = await exchangeCode({ env: c.env, code, redirectUri: `${origin}/auth/callback`, verifier });
  if (!token) return c.json({ error: "exchange_failed" }, 401);

  const ghUser = await getUser(token);
  if (!ghUser) return c.json({ error: "identity_failed" }, 401);
  if (!(await isActiveOrgMember(token))) return c.json({ error: "forbidden" }, 403);

  await run(c.env.DB,
    `INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(github_login) DO UPDATE SET name = excluded.name`,
    ghUser.login, ghUser.name, nowIso());

  const { id } = await createSession(c.env.DB, ghUser.login);
  await setSessionCookie(c, id, c.env.COOKIE_SECRET);
  return c.redirect("/", 302);
});

// GATED (by sessionGate in src/routes.ts): revoke this session.
authApp.post("/logout", async (c) => {
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (id) await deleteSession(c.env.DB, id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// GATED: mint a personal MCP bearer token; the raw token is shown ONCE.
authApp.post("/mcp-token", async (c) => {
  const { raw } = await mintToken(c.env.DB, c.get("principal").login);
  return c.json({ token: raw });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/auth-routes.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/auth/routes.ts test/auth-routes.test.ts
git commit -m "feat(auth): add /auth login, callback, logout, mcp-token routes"
```

---

## Task 8: Thread principal into the consumer (author override)

**Files:**
- Modify: `src/consumer.ts`, `test/consumer.vocab-gate.test.ts` (update the two `consume(...)` calls)
- Test: `test/auth-author-override.test.ts`

**Interfaces:**
- Consumes: `src/auth/principal.ts` (`Principal` — type only).
- Produces: `consume(db: DB, payload: IngestPayload, principal: Principal): Promise<IngestResult>` (author from `principal.login`, ignoring `payload.session.author`).

- [ ] **Step 1: Write the failing test** (required test 2)

`test/auth-author-override.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { IngestPayload } from "@shared/contract";
import { consume } from "../src/consumer";
import { all } from "../src/db";
import type { FeedRow, DocVersionRow } from "@shared/rows";

describe("author override", () => {
  it("stores the authenticated principal as author, ignoring the payload's claimed session.author", async () => {
    const payload = IngestPayload.parse({
      session: { author: "someone-else", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" },
      feed_entries: [{ summary: "s", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [] } }],
      doc_proposals: [{ slug: "architecture", section: "reference", title: "Architecture", body: "x", change_summary: "c", confidence: "high" }],
    });

    await consume(env.DB, payload, { login: "real-user" });

    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(1);
    expect(feed[0].author).toBe("real-user");

    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(versions[0].created_by).toBe("real-user");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-author-override.test.ts`
Expected: FAIL — `consume` expects 2 args / type error, or `feed[0].author` is `"someone-else"`.

- [ ] **Step 3: Update `src/consumer.ts`**

Add the import at the top:
```ts
import type { Principal } from "./auth/principal";
```
Change the signature and the author source (the body is otherwise unchanged):
```ts
export async function consume(db: DB, payload: IngestPayload, principal: Principal): Promise<IngestResult> {
  const author = principal.login; // authenticated principal; payload.session.author is advisory and ignored
  const result: IngestResult = { feed: 0, docs: 0, adrs: 0, triaged: 0 };
  // ... rest of the function unchanged (it already uses `author` everywhere) ...
```

- [ ] **Step 4: Update the existing `test/consumer.vocab-gate.test.ts`**

Both `it` blocks call `consume(env.DB, payload)`. Add a principal argument to each call:
```ts
    const result = await consume(env.DB, payload, { login: "andres" });
```
(There are two such calls — update both.)

- [ ] **Step 5: Run to verify both pass**

Run: `npx vitest run test/auth-author-override.test.ts test/consumer.vocab-gate.test.ts`
Expected: PASS (1 + 2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/consumer.ts test/auth-author-override.test.ts test/consumer.vocab-gate.test.ts
git commit -m "feat(auth): derive author from the principal in the consumer"
```

---

## Task 9: Thread principal into the MCP server

**Files:**
- Modify: `src/mcp.ts`

**Interfaces:**
- Consumes: `src/auth/principal.ts` (`Principal` — type only).
- Produces: `handleMcp(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response>`. The `append_feed` and `propose_doc_update` tools no longer take an `author` input field — they use `principal.login`.

- [ ] **Step 1: Update `src/mcp.ts`**

Add the import:
```ts
import type { Principal } from "./auth/principal";
```
Change the signature:
```ts
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
```
Replace the `append_feed` tool registration with (no `author` field; author from principal):
```ts
  server.tool(
    "append_feed",
    "Append an entry to the append-only feed (working memory).",
    { summary: z.string(), body: z.string().optional(), tags: z.array(z.string()).optional() },
    async ({ summary, body, tags }) =>
      runTool(async () => ({ id: await append_feed(env.DB, { author: principal.login, summary, body, tags }) }))
  );
```
Replace the `propose_doc_update` tool registration with (no `author` field):
```ts
  server.tool(
    "propose_doc_update",
    "Stage a new doc version (non-destructive; current_version is untouched).",
    {
      slug: z.string(),
      section: z.string(),
      title: z.string().optional(),
      body: z.string(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
    },
    async (proposal) => runTool(() => propose_doc_update(env.DB, proposal, principal.login))
  );
```
(The read tools — `get_doc`, `list_docs`, `get_feed`, `search_context` — are unchanged.)

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc -p tsconfig.worker.json`
Expected: exit 0. (`index.ts` still calls `handleMcp(request, env, ctx)` with 3 args and will now be a type error — that call is fixed in Task 10. If running tsc before Task 10, expect exactly that one error in `src/index.ts`; it is resolved by Task 10. To keep this task green on its own, proceed to commit only after confirming the only tsc error, if any, is the `index.ts` arity at the `handleMcp` call site.)

- [ ] **Step 3: Commit**

```bash
git add src/mcp.ts
git commit -m "feat(auth): derive author from the principal in MCP write tools"
```

---

## Task 10: Wire the edge (routes gate + /mcp bearer) — fail closed

**Files:**
- Modify: `src/routes.ts`, `src/index.ts`
- Test: `test/auth-gate.test.ts`

**Interfaces:**
- Consumes: `src/auth/principal.ts` (`AppEnv`, `sessionGate`, `resolveBearerPrincipal`), `src/auth/routes.ts` (`authApp`), `src/mcp.ts` (`handleMcp(req, env, ctx, principal)`), `src/consumer.ts` (`consume(db, payload, principal)`).
- Produces: gated HTTP routes (cookie) + bearer-gated `/mcp` (bare 401).

- [ ] **Step 1: Write the failing test** (required test 1 + the /mcp bare-401 half of test 3)

`test/auth-gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { all } from "../src/db";
import type { FeedRow } from "@shared/rows";

const ingestBody = JSON.stringify({
  session: { author: "x", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" },
  feed_entries: [{ summary: "s", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [] } }],
});

describe("auth gate (fails closed)", () => {
  it("rejects an unauthenticated write with 401 and writes nothing", async () => {
    const res = await SELF.fetch("https://example.com/ingest", {
      method: "POST", headers: { "content-type": "application/json" }, body: ingestBody,
    });
    expect(res.status).toBe(401);
    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(0); // nothing written
  });

  it("rejects /mcp with a bad bearer using a bare 401 (no WWW-Authenticate, no OAuth advertisement)", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sapling_mcp_bad",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-gate.test.ts`
Expected: FAIL — `/ingest` currently returns 200 (no gate yet) and the feed has 1 row; `/mcp` currently returns a non-401.

- [ ] **Step 3: Rewrite `src/routes.ts`**

```ts
import { Hono } from "hono";
import { IngestPayload } from "@shared/contract";
import type { AppEnv } from "./auth/principal";
import { sessionGate } from "./auth/principal";
import { authApp } from "./auth/routes";
import { consume } from "./consumer";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";

export const app = new Hono<AppEnv>();

// Gate first: everything except /auth/login and /auth/callback requires a session.
// Fails closed with 401 (no data in the body).
app.use("*", sessionGate);

// Auth endpoints (login/callback public via the gate's allowlist; logout/mcp-token gated).
app.route("/auth", authApp);

app.post("/ingest", async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = IngestPayload.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  // SEAM: a Cloudflare Queue producer.send({ payload, principal }) would slot in here.
  const result = await consume(c.env.DB, parsed.data, c.get("principal"));
  return c.json({ ok: true, result });
});

app.get("/docs", async (c) => {
  const docs = await list_docs(c.env.DB, c.req.query("section"));
  return c.json({ docs });
});

app.get("/doc/:slug", async (c) => {
  const found = await get_doc(c.env.DB, c.req.param("slug"));
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json(found);
});

app.get("/feed", async (c) => {
  const tags = c.req.query("tags");
  const limit = c.req.query("limit");
  const feed = await get_feed(c.env.DB, {
    author: c.req.query("author"),
    tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    since: c.req.query("since"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ feed });
});

app.get("/search", async (c) => {
  const limit = c.req.query("limit");
  const results = await search_context(c.env.DB, c.req.query("q") ?? "", {
    section: c.req.query("section"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ results });
});
```

- [ ] **Step 4: Rewrite `src/index.ts`**

```ts
import { app } from "./routes";
import { handleMcp } from "./mcp";
import { resolveBearerPrincipal } from "./auth/principal";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Static assets are served by the assets binding before this handler runs.
    if (url.pathname === "/mcp") {
      // Bearer ONLY. On missing/invalid credentials: bare 401, NO WWW-Authenticate,
      // NO OAuth discovery/metadata — Claude Code must use the configured header.
      const principal = await resolveBearerPrincipal(request, env);
      if (!principal) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return handleMcp(request, env, ctx, principal);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run to verify it passes (and the whole suite)**

Run: `npx vitest run test/auth-gate.test.ts`
Expected: PASS (2 tests).
Run: `npm test`
Expected: full suite green (the 5 original + all new auth tests).

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts src/index.ts test/auth-gate.test.ts
git commit -m "feat(auth): gate HTTP routes by session and /mcp by bearer (fail closed)"
```

---

## Task 11: Docs + contract advisory comment

**Files:**
- Modify: `shared/contract.ts` (comment), `README.md` (secrets section)

**Interfaces:**
- Produces: no code interfaces; documentation + the advisory comment.

- [ ] **Step 1: Annotate `Session.author` in `shared/contract.ts`**

Change the `author` line inside `export const Session = z.object({ ... })`:
```ts
  author: z.string(),   // advisory only — overwritten server-side from the authenticated principal
```

- [ ] **Step 2: Add a Secrets section to `README.md`**

Append:
```markdown
## Auth & secrets

Auth gates all data routes (session cookie) and `/mcp` (per-person bearer token), allowing
only active members of the `SaplingLearn` GitHub org. Set these Wrangler secrets (never commit them):

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — a GitHub OAuth App whose callback is
  `https://<host>/auth/callback`.
- `COOKIE_SECRET` — a long random string used to sign the session cookie.

Production: `wrangler secret put GITHUB_CLIENT_ID` (and the others).
Local dev: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill it in.
The `database_id` in `wrangler.toml` is still a local placeholder — replace it with a real id
(`npm run db:create`) before any remote deploy.

Mint an MCP token from a logged-in session: `POST /auth/mcp-token` → `{ "token": "sapling_mcp_..." }`
(shown once). Connect Claude Code with `--header "Authorization: Bearer sapling_mcp_..."`.
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc -p tsconfig.worker.json` → exit 0.
```bash
git add shared/contract.ts README.md
git commit -m "docs(auth): mark session.author advisory; document secrets and MCP token"
```

---

## Task 12: Integration verification (suite + live dev smoke)

**Files:**
- Modify (only if a wiring fix is needed): any `src/*`
- Create: none (verification)

**Interfaces:**
- Consumes: the whole build.

- [ ] **Step 1: Type-check both projects**

Run: `npm run typecheck`
Expected: both `tsc` invocations exit 0.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: PASS — the 5 original tests + the new auth tests (auth-crypto 4, auth-github 2, auth-session 4, auth-tokens 3, auth-principal 4, auth-routes 1, auth-author-override 1, auth-gate 2).

- [ ] **Step 3: Build web + apply migrations + start dev server (background)**

Run: `npm run db:migrate:local`
Run: `npm run build:web`
Provide local secrets so the worker boots (write a temporary `.dev.vars` with dummy values — it is git-ignored):
```
GITHUB_CLIENT_ID=dev-client-id
GITHUB_CLIENT_SECRET=dev-client-secret
COOKIE_SECRET=dev-cookie-secret
```
Start in the background, logging to the scratchpad, record the PID:
`npx wrangler dev --port 8787 > <scratchpad>/wdev.log 2>&1 &`
Poll `http://localhost:8787/auth/login` (or grep the log for "Ready on") up to ~90s.

- [ ] **Step 4: Live smoke (fail-closed gating + no OAuth advertisement)**

Run:
```bash
# unauthenticated data route -> 401, no data
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/feed            # expect 401
# /mcp bad bearer -> bare 401, no WWW-Authenticate
curl -s -D - -o /dev/null -X POST http://localhost:8787/mcp \
  -H 'authorization: Bearer sapling_mcp_bad' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -i "HTTP/\|www-authenticate"
# login redirect -> 302 to github with PKCE
curl -s -D - -o /dev/null http://localhost:8787/auth/login | grep -i "location:"
```
Expected: `/feed` → `401`; `/mcp` → `HTTP/... 401` with **no `www-authenticate` line**; `/auth/login` → `location: https://github.com/login/oauth/authorize?...code_challenge_method=S256...`.

- [ ] **Step 5: Stop the dev server and clean up**

Stop wrangler (`kill <PID>`; `pkill -f "wrangler dev"`). Confirm no orphan process and the port is free. Remove the temporary `.dev.vars` if it was created only for this smoke.

- [ ] **Step 6: Commit any fixes**

If Steps 1–4 required wiring fixes, commit them:
```bash
git add -A
git commit -m "fix(auth): integration wiring for gated routes and /mcp bearer"
```
If no fixes were needed, state that explicitly and create no empty commit.

---

## Self-Review

**Spec coverage** — each spec section maps to a task:
- Identity model / org gating → Tasks 3 (`isActiveOrgMember`, `state==="active"`), 7 (callback), 6/10 (gating).
- Site OAuth + PKCE + session cookie → Tasks 2 (PKCE/HMAC), 3 (flow), 4 (session+cookie), 7 (routes).
- MCP bearer (mint once, store hash, resolve, bump last_used_at) → Tasks 5, 7 (`/mcp-token`), 6/10 (resolution + gate).
- The no-OAuth-advertisement bare 401 → Task 10 (`index.ts`) + Task 10 test + Task 12 live check.
- Principal plumbing (edge resolution, data arg, author derivation, ignore `session.author`) → Tasks 6, 8, 9, 10.
- New D1 tables + row types + truncate → Task 1.
- Secrets + README + contract comment → Tasks 1 (env/.dev.vars), 11.
- The four required tests → Task 10 (unauth write 401 + /mcp bad bearer bare 401), Task 8 (author override), Task 6 (bad/good bearer resolution).
- Deferred seams (OAuth provider, rotation, RBAC, rate limiting) → not built; documented in spec §13.
- Build order followed (migrations → auth module → principal/routes → thread into consumer/mcp → /mcp edge → tests).

**Placeholder scan:** every code step has complete code; every run step has an exact command + expected output. No TBD/"handle errors"/"similar to".

**Type consistency:** `Principal = { login: string }` defined in Task 6 and used by Tasks 8 (`consume(db, payload, principal)`), 9 (`handleMcp(..., principal)`), 10 (`AppEnv`, `sessionGate`, `resolveBearerPrincipal`). `resolveToken`/`resolveBearerPrincipal`/`createSession`/`getSessionUser` signatures match across the task that defines them and the tasks that call them. `consume`'s new 3rd arg is reflected in the route call (Task 10) and the updated existing test (Task 8). `handleMcp`'s new 4th arg is reflected in `index.ts` (Task 10) — Task 9 notes the transient single-arity tsc error resolved in Task 10.

## Execution Handoff

See the chat for the execution-mode choice.
