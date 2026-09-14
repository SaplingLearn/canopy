# Google Sign-in + Person-centric Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins invite Google accounts into Canopy (with an invite email), have every person key on a chosen handle instead of a GitHub login, and let people pick a color and link both sign-in methods.

**Architecture:** One migration replaces `users` + `people` with `persons` + `identities` + `invites` and repoints `sessions` / `mcp_tokens`. A second OAuth provider (Google, PKCE, ID-token verified against Google's JWKS) lands in the existing session-cookie auth class; both callbacks feed one shared "fork" that resolves an identity to a person, links by verified email, onboards from an invite (sealed cookie, no pending rows), or refuses. The invite email rides the digest delivery gate. The web SPA gains a Google button, a not-invited card, an onboarding screen, Settings › Profile, and Maintenance › People.

**Tech Stack:** Cloudflare Worker (Hono 4, D1 via Miniflare in Vitest), Web Crypto (HMAC, PKCE, RS256 JWKS verify), Zod, vanilla TypeScript/Vite SPA, Resend over fetch.

**Spec:** `docs/superpowers/specs/2026-09-14-google-signin-identity-design.md`

## Global Constraints

- Handle regex for NEW handles: `^[a-z][a-z0-9-]{1,23}$`. Reserved: `github-webhook`, `system`, `admin`, `canopy`, `me`. Uniqueness is case-insensitive (`COLLATE NOCASE`).
- Color tokens, exactly: `moss fern sky slate plum rose rust ochre clay stone`.
- `Principal` becomes `{ handle: string }`. `ADMIN_LOGINS` keeps its name; its values are handles.
- Auth classes stay three (session cookie / bearer / webhook). Google is a second PROVIDER in the session-cookie class. `/mcp` behaviour unchanged.
- Onboarding state lives ONLY in a sealed `onboard` cookie (10-minute max-age). Nothing pending is written to D1.
- Every network call (Google, GitHub, Resend) is injectable via `fetchImpl?: typeof fetch`. Tests never hit the network. Tests assert on D1 rows.
- Invite email goes through `deliveryFor` (local → `notification_outbox_bodies`; resend → Resend). It is NOT a notification kind.
- Nothing is hard-deleted except an identity row on explicit unlink. Invites revoke softly.
- Commit after every task with the attribution footer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QzGqcyJP14Bqa6psmb65Zk
  ```
- Run `npx vitest run test/<file>.test.ts` per task and `npm test && npm run typecheck` at the end of Tasks 4, 9, 12.
- A `GEMINI_API_KEY` in `.dev.vars` fails one unrelated summarizer test; that is environmental.

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/0023_persons.sql` | persons / identities / invites; backfill; repoint sessions + mcp_tokens; bodies table without FK; drop users + people |
| `shared/rows.ts` | `PersonRow` (new shape), `IdentityRow`, `InviteRow`; `SessionRow.person`, `McpTokenRow.person`; `PERSON_COLORS` |
| `shared/dashboard.ts` | unchanged shape (`person` is still the display name) |
| `scripts/seed/reset.mjs` | truncation order + persons/identities seed |
| `src/auth/persons.ts` | NEW. `HANDLE_RE`, `RESERVED_HANDLES`, `isValidHandle`, `defaultColor`, `getPerson`, `findIdentity`, `findPersonByEmail`, `recordSignIn`, `createPerson`, `linkIdentity`, `unlinkIdentity`, `listIdentities`, `handleAvailable`, `updateProfile`, `listPersons` |
| `src/auth/users.ts` | DELETED |
| `src/auth/principal.ts` | `Principal = { handle }`; `PUBLIC_PATHS` extended |
| `src/auth/session.ts`, `src/auth/tokens.ts` | column `person` |
| `src/auth/crypto.ts` | export `b64uEncode` / `b64uDecode` (string ↔ base64url), `importJwk`-free helpers stay here |
| `src/auth/google.ts` | NEW. `buildGoogleAuthorizeUrl`, `exchangeGoogleCode`, `verifyGoogleIdToken`, `GoogleProfile` |
| `src/auth/github.ts` | add optional `fetchImpl` to `exchangeCode`, `getUser`, `isActiveOrgMember` |
| `src/auth/onboard.ts` | NEW. `ProviderProfile`, `sealOnboard`/`openOnboard` cookie, `completeSignIn` (the fork), `linkSignIn` |
| `src/auth/routes.ts` | `buildAuthApp(deps)`; GitHub + Google login/callback; onboard routes; `/me` GET+PUT; unlink |
| `src/auth/invites.ts` | NEW. `createInvite`, `revokeInvite`, `acceptInvite`, `findLiveInvite`, `listInvites` |
| `src/notifications/invite.ts` | NEW. `renderInviteEmail`, `sendInvite` |
| `src/notifications/delivery.ts`, `resend.ts`, `assemble.ts` | optional `unsubscribeUrl`; export `EMAIL_COLORS`, `EMAIL_FONT` |
| `src/routes.ts` | `/persons`, `/invites*`, identity map targets a handle |
| `src/tools/mywork.ts`, `writes.ts`, `reads.ts`, `src/notifications/*` | `people` → `identities`/`persons` |
| `src/index.ts` | unsubscribe writes `persons` |
| `web/src/api.ts`, `render.ts`, `main.ts`, `maintenance.ts`, `ui.ts`, `canopy.css`, `people.ts` (NEW) | screens |
| `test/helpers/persons.ts` | NEW. `seedPerson`, `cookieFor` shared by route tests |
| `CLAUDE.md`, `test/env.d.ts`, `vitest.config.ts`, `wrangler.toml` comments | docs + env |

---

### Task 1: Migration 0023 — persons, identities, invites

**Files:**
- Create: `migrations/0023_persons.sql`
- Modify: `shared/rows.ts` (replace `UserRow` and the old `PersonRow`; `SessionRow`, `McpTokenRow`)
- Modify: `scripts/seed/reset.mjs`
- Test: `test/migrations.persons.test.ts`

**Interfaces:**
- Produces: tables `persons(handle PK, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at)`, `identities(provider, subject PK; label, person FK, linked_at, linked_by)`, `invites(email PK, name, invited_by, invited_at, accepted_by, revoked_at, email_sent_at, email_id, email_error)`; `sessions.person`, `mcp_tokens.person`; `notification_outbox_bodies` with no FK.
- Produces: `PersonRow`, `IdentityRow`, `InviteRow`, `PERSON_COLORS`, `PersonColor` in `@shared/rows`.

- [ ] **Step 1: Write the failing migration test**

`test/migrations.persons.test.ts`:

```ts
/**
 * 0023_persons: replay the migration against a pre-0023 shape and assert the
 * backfill. The harness applied every migration at startup, so this test
 * rebuilds the OLD tables (users, people, sessions, mcp_tokens, bodies), drops
 * the NEW ones, seeds old-shape rows, then re-runs 0023's statements.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import type { PersonRow, IdentityRow, IdentityTaskRow } from "@shared/rows";

const OLD_SHAPE = `
DROP TABLE IF EXISTS identities; DROP TABLE IF EXISTS invites; DROP TABLE IF EXISTS persons;
DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS mcp_tokens; DROP TABLE IF EXISTS notification_outbox_bodies;
CREATE TABLE users (github_login TEXT PRIMARY KEY, name TEXT, created_at TEXT NOT NULL, avatar_url TEXT, email TEXT, email_unsubscribed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE people (login TEXT PRIMARY KEY, person TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(github_login), created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL REFERENCES users(github_login), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE notification_outbox_bodies (idempotency_key TEXT PRIMARY KEY REFERENCES notification_outbox(idempotency_key), to_address TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO users (github_login, name, created_at, avatar_url, email, email_unsubscribed) VALUES
  ('AndresL230', 'Andres', '2026-01-01T00:00:00Z', 'https://a/andres.png', 'andres@example.com', 0),
  ('Jose-Gael-Cruz-Lopez', 'Jose', '2026-01-02T00:00:00Z', NULL, NULL, 1);
INSERT INTO people (login, person) VALUES
  ('AndresL230', 'Andres'),
  ('andres-alt', 'Andres'),
  ('jose-bot-acct', 'Jose-Gael-Cruz-Lopez'),
  ('lpcooper-arch', 'Luke');
INSERT INTO sessions (id, user, created_at, expires_at) VALUES ('s1', 'AndresL230', '2026-01-03T00:00:00Z', '2099-01-01T00:00:00Z');
INSERT INTO mcp_tokens (user, token_hash, created_at) VALUES ('AndresL230', 'hash1', '2026-01-03T00:00:00Z');
`;

async function replay0023(): Promise<void> {
  await env.DB.exec(OLD_SHAPE.trim().split("\n").join(" "));
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0023"));
  if (!m) throw new Error("0023 migration not found");
  for (const q of m.queries) await env.DB.prepare(q).run();
}

describe("0023_persons backfill", () => {
  beforeEach(replay0023);

  it("every users row becomes a person with handle = login and a github identity", async () => {
    const andres = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`))!;
    expect(andres.name).toBe("Andres");
    expect(andres.avatar_url).toBe("https://a/andres.png");
    expect(andres.email).toBe("andres@example.com");
    expect(andres.onboarded_at).toBe("2026-01-01T00:00:00Z");
    expect(["moss","fern","sky","slate","plum","rose","rust","ochre","clay","stone"]).toContain(andres.color);
    const jose = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'Jose-Gael-Cruz-Lopez'`))!;
    expect(jose.email_unsubscribed).toBe(1);
    const gh = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'github' AND subject = 'AndresL230'`);
    expect(gh?.person).toBe("AndresL230");
    expect(gh?.label).toBe("AndresL230");
    expect(gh?.linked_by).toBe("migration");
  });

  it("people rows map by login first, then by display name; unmatched raise an identity task", async () => {
    const byLogin = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'jose-bot-acct'`);
    expect(byLogin?.person).toBe("Jose-Gael-Cruz-Lopez");
    const byName = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'andres-alt'`);
    expect(byName?.person).toBe("AndresL230");
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'lpcooper-arch'`);
    expect(task?.status).toBe("pending");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'lpcooper-arch'`)).toBeNull();
  });

  it("sessions and mcp_tokens are repointed to persons.handle and old tables are gone", async () => {
    const s = await first<{ person: string }>(env.DB, `SELECT person FROM sessions WHERE id = 's1'`);
    expect(s?.person).toBe("AndresL230");
    const t = await first<{ person: string }>(env.DB, `SELECT person FROM mcp_tokens WHERE token_hash = 'hash1'`);
    expect(t?.person).toBe("AndresL230");
    const tables = (await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','people')`)).map((r) => r.name);
    expect(tables).toEqual([]);
  });

  it("the bodies table no longer references the outbox, and the color CHECK holds", async () => {
    const fks = await all(env.DB, `SELECT * FROM pragma_foreign_key_list('notification_outbox_bodies')`);
    expect(fks).toHaveLength(0);
    await expect(env.DB.prepare(`INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('x', 'X', 'neon', 't', 't')`).run()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/migrations.persons.test.ts`
Expected: FAIL with "0023 migration not found".

- [ ] **Step 3: Write the migration**

`migrations/0023_persons.sql`:

```sql
-- Person-centric identity (2026-09-14 design). A person is the root identity;
-- the GitHub login and Google subject are rows in `identities`. Replaces
-- `users` (one row per GitHub login) and `people` (login → display-name map).
-- Existing GitHub users keep their login as their handle, so every stored
-- recorded_by / created_by / user_id string keeps its meaning.

CREATE TABLE persons (
  handle TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT,
  color TEXT NOT NULL CHECK (color IN ('moss','fern','sky','slate','plum','rose','rust','ochre','clay','stone')),
  avatar_url TEXT,
  email TEXT,
  email_unsubscribed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  onboarded_at TEXT NOT NULL
);

CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('github','google')),
  subject TEXT NOT NULL,                  -- github: the login; google: the stable `sub` claim
  label TEXT NOT NULL,                    -- github login / google email
  person TEXT NOT NULL REFERENCES persons(handle),
  linked_at TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_identities_person ON identities(person);

CREATE TABLE invites (
  email TEXT PRIMARY KEY,                 -- lowercased
  name TEXT,
  invited_by TEXT NOT NULL,
  invited_at TEXT NOT NULL,
  accepted_by TEXT,
  revoked_at TEXT,
  email_sent_at TEXT,
  email_id TEXT,
  email_error TEXT
);

-- Backfill persons from users. Color: a stable hash of the login over the ten tokens.
INSERT INTO persons (handle, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at)
SELECT github_login, name,
  CASE (unicode(github_login) + length(github_login)) % 10
    WHEN 0 THEN 'moss' WHEN 1 THEN 'fern' WHEN 2 THEN 'sky' WHEN 3 THEN 'slate' WHEN 4 THEN 'plum'
    WHEN 5 THEN 'rose' WHEN 6 THEN 'rust' WHEN 7 THEN 'ochre' WHEN 8 THEN 'clay' ELSE 'stone' END,
  avatar_url, email, email_unsubscribed, created_at, created_at
FROM users;

INSERT INTO identities (provider, subject, label, person, linked_at, linked_by)
SELECT 'github', github_login, github_login, github_login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration' FROM users;

-- people → identities: match the display-name column to a person by login first, then by name.
INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by)
SELECT 'github', p.login, p.login, u.github_login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration'
FROM people p JOIN users u ON u.github_login = p.person;
INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by)
SELECT 'github', p.login, p.login, u.github_login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration'
FROM people p JOIN users u ON u.name = p.person;
-- Anything left is not guessed: an admin maps it in Maintenance.
INSERT OR IGNORE INTO identity_tasks (login, first_seen, status)
SELECT p.login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending'
FROM people p WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.provider = 'github' AND i.subject = p.login);

-- Repoint sessions + mcp_tokens (D1 cannot rename an FK'd column: recreate).
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  person TEXT NOT NULL REFERENCES persons(handle),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO sessions_new (id, person, created_at, expires_at) SELECT id, user, created_at, expires_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_person ON sessions(person);

CREATE TABLE mcp_tokens_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL REFERENCES persons(handle),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
INSERT INTO mcp_tokens_new (id, person, token_hash, created_at, last_used_at, revoked) SELECT id, user, token_hash, created_at, last_used_at, revoked FROM mcp_tokens;
DROP TABLE mcp_tokens;
ALTER TABLE mcp_tokens_new RENAME TO mcp_tokens;
CREATE INDEX idx_mcp_tokens_person ON mcp_tokens(person);

-- The dev-only bodies store loses its FK so transactional mail (invites) can land there too.
CREATE TABLE notification_outbox_bodies_new (
  idempotency_key TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO notification_outbox_bodies_new SELECT idempotency_key, to_address, subject, html, text, created_at FROM notification_outbox_bodies;
DROP TABLE notification_outbox_bodies;
ALTER TABLE notification_outbox_bodies_new RENAME TO notification_outbox_bodies;

DROP TABLE people;
DROP TABLE users;
```

- [ ] **Step 4: Row types**

In `shared/rows.ts` replace the `UserRow` block (lines 77-84) with:

```ts
export const PERSON_COLORS = ["moss", "fern", "sky", "slate", "plum", "rose", "rust", "ochre", "clay", "stone"] as const;
export type PersonColor = (typeof PERSON_COLORS)[number];

// The root identity (0023). handle is chosen once at onboarding (migrated
// GitHub users keep their login). email is the notification address (0021 rule:
// never overwrites a user/admin-set value).
export interface PersonRow {
  handle: string;
  name: string | null;
  color: PersonColor;
  avatar_url: string | null;
  email: string | null;
  email_unsubscribed: number;
  created_at: string;
  onboarded_at: string;
}

export type IdentityProvider = "github" | "google";

// One sign-in method attached to a person (0023). github.subject = login;
// google.subject = the stable `sub` claim. label is what a human sees.
export interface IdentityRow {
  provider: IdentityProvider;
  subject: string;
  label: string;
  person: string;
  linked_at: string;
  linked_by: string;
}

// The Google gate (0023): only an invited, verified address may create a person.
export interface InviteRow {
  email: string;
  name: string | null;
  invited_by: string;
  invited_at: string;
  accepted_by: string | null;
  revoked_at: string | null;
  email_sent_at: string | null;
  email_id: string | null;
  email_error: string | null;
}
```

Change `SessionRow.user` → `person: string` and `McpTokenRow.user` → `person: string`. Delete the old `PersonRow { login; person }` block (lines 192-195); keep `IdentityTaskRow`.

- [ ] **Step 5: Reset list**

In `scripts/seed/reset.mjs` replace the four lines `"DELETE FROM identity_tasks"` … `"INSERT INTO people …"` and the trailing `"DELETE FROM sessions"`, `"DELETE FROM mcp_tokens"`, `"DELETE FROM users"` with (keep the notification lines between them where they are):

```js
  "DELETE FROM identity_tasks",
  // …notification lines stay here…
  "DELETE FROM sessions",
  "DELETE FROM mcp_tokens",
  "DELETE FROM identities",
  "DELETE FROM invites",
  "DELETE FROM persons",
  // The dev/test person seed (was the `people` map): four persons, each with their github identity.
  "INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('AndresL230', 'Andres', 'moss', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('Jose-Gael-Cruz-Lopez', 'Jose', 'sky', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('lpcooper-arch', 'Luke', 'fern', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('Darkest-Teddy', 'Jack', 'plum', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  "INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'AndresL230', 'AndresL230', 'AndresL230', '2026-01-01T00:00:00Z', 'seed'), ('github', 'Jose-Gael-Cruz-Lopez', 'Jose-Gael-Cruz-Lopez', 'Jose-Gael-Cruz-Lopez', '2026-01-01T00:00:00Z', 'seed'), ('github', 'lpcooper-arch', 'lpcooper-arch', 'lpcooper-arch', '2026-01-01T00:00:00Z', 'seed'), ('github', 'Darkest-Teddy', 'Darkest-Teddy', 'Darkest-Teddy', '2026-01-01T00:00:00Z', 'seed')",
```

Order matters: sessions and mcp_tokens (FK → persons) before identities, then persons, then the seed.

- [ ] **Step 6: Run the migration test**

Run: `npx vitest run test/migrations.persons.test.ts`
Expected: PASS (4 tests). Typecheck will be red until Task 2 — expected.

- [ ] **Step 7: Commit**

```bash
git add migrations/0023_persons.sql shared/rows.ts scripts/seed/reset.mjs test/migrations.persons.test.ts
git commit -m "feat(identity): 0023 persons/identities/invites migration + row types"
```

---

### Task 2: Persons module, principal rename, session/token columns, test helper

**Files:**
- Create: `src/auth/persons.ts`, `test/helpers/persons.ts`
- Delete: `src/auth/users.ts`
- Modify: `src/auth/principal.ts`, `src/auth/session.ts`, `src/auth/tokens.ts`, `src/auth/routes.ts` (only the `recordLogin` import/call and `/me`), `src/mcp.ts`, `src/consumer.ts:301`, `src/routes.ts` (every `c.get("principal").login`), `src/notifications/routes.ts` (every `c.get("principal").login`)
- Test: `test/auth-persons.test.ts` (new), `test/auth-email-seed.test.ts` (rewrite the `recordLogin` block), `test/auth-session.test.ts`, `test/auth-tokens.test.ts`, `test/auth-principal.test.ts`, `test/auth-me.test.ts`

**Interfaces:**
- Produces `src/auth/persons.ts`:
  ```ts
  export const HANDLE_RE = /^[a-z][a-z0-9-]{1,23}$/;
  export const RESERVED_HANDLES: readonly string[];
  export type HandleProblem = "invalid" | "reserved" | "taken";
  export function isValidHandle(h: string): boolean;                       // regex only
  export function defaultColor(seed: string): PersonColor;                 // stable hash
  export async function getPerson(db, handle): Promise<PersonRow | null>; // case-insensitive
  export async function findIdentity(db, provider, subject): Promise<IdentityRow | null>;
  export async function findPersonByEmail(db, email): Promise<PersonRow | null>;
  export async function handleAvailable(db, handle): Promise<{ available: boolean; reason?: HandleProblem }>;
  export async function recordSignIn(db, handle, profile: { name: string | null; avatar_url: string | null; email: string | null }): Promise<void>; // name/avatar refresh, email COALESCE
  export async function createPerson(db, p: { handle; name; color; avatar_url; email }): Promise<PersonRow>; // throws HandleTakenError
  export class HandleTakenError extends Error {}
  export async function linkIdentity(db, i: { provider; subject; label; person; linkedBy }): Promise<void>;
  export async function unlinkIdentity(db, person, provider): Promise<"ok" | "last_identity" | "not_found">;
  export async function listIdentities(db, person): Promise<IdentityRow[]>;
  export async function updateProfile(db, handle, patch: { name?: string | null; color?: PersonColor }): Promise<PersonRow | null>;
  export async function listPersons(db): Promise<Pick<PersonRow, "handle" | "name" | "color" | "avatar_url">[]>;
  ```
- Produces `src/auth/principal.ts`: `export interface Principal { handle: string }`.
- Produces `test/helpers/persons.ts`: `seedPerson(handle, opts?)`, `cookieFor(handle, opts?)` (creates the person if missing, inserts a session, returns the `session=` cookie string).

- [ ] **Step 1: Write the failing persons-module test**

`test/auth-persons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first } from "../src/db";
import {
  isValidHandle, defaultColor, handleAvailable, createPerson, HandleTakenError, recordSignIn,
  linkIdentity, unlinkIdentity, listIdentities, findIdentity, findPersonByEmail, updateProfile, listPersons, getPerson,
} from "../src/auth/persons";
import type { PersonRow } from "@shared/rows";

describe("handle rules", () => {
  it("validates the regex", () => {
    expect(isValidHandle("priya")).toBe(true);
    expect(isValidHandle("p-1")).toBe(true);
    expect(isValidHandle("Priya")).toBe(false);
    expect(isValidHandle("1p")).toBe(false);
    expect(isValidHandle("p")).toBe(false);
    expect(isValidHandle("a".repeat(25))).toBe(false);
  });
  it("defaultColor is stable and in the palette", () => {
    expect(defaultColor("AndresL230")).toBe(defaultColor("AndresL230"));
    expect(["moss","fern","sky","slate","plum","rose","rust","ochre","clay","stone"]).toContain(defaultColor("x"));
  });
  it("handleAvailable: invalid, reserved, taken (case-insensitive), available", async () => {
    expect(await handleAvailable(env.DB, "Bad")).toEqual({ available: false, reason: "invalid" });
    expect(await handleAvailable(env.DB, "admin")).toEqual({ available: false, reason: "reserved" });
    expect(await handleAvailable(env.DB, "andresl230")).toEqual({ available: false, reason: "taken" }); // seeded AndresL230
    expect(await handleAvailable(env.DB, "priya")).toEqual({ available: true });
  });
});

describe("createPerson / recordSignIn", () => {
  it("creates a person and refuses a case-colliding handle", async () => {
    const p = await createPerson(env.DB, { handle: "priya", name: "Priya N", color: "plum", avatar_url: null, email: "priya@example.com" });
    expect(p.handle).toBe("priya");
    expect(p.onboarded_at).toBeTruthy();
    await expect(createPerson(env.DB, { handle: "PRIYA", name: null, color: "moss", avatar_url: null, email: null })).rejects.toBeInstanceOf(HandleTakenError);
  });
  it("recordSignIn refreshes name/avatar and never overwrites a set email", async () => {
    await createPerson(env.DB, { handle: "priya", name: "Priya", color: "plum", avatar_url: null, email: "set@example.com" });
    await recordSignIn(env.DB, "priya", { name: "Priya Natarajan", avatar_url: "https://a/p.png", email: "other@example.com" });
    const row = (await getPerson(env.DB, "priya"))!;
    expect(row.name).toBe("Priya Natarajan");
    expect(row.avatar_url).toBe("https://a/p.png");
    expect(row.email).toBe("set@example.com");
  });
  it("recordSignIn fills a NULL email", async () => {
    await createPerson(env.DB, { handle: "priya", name: null, color: "plum", avatar_url: null, email: null });
    await recordSignIn(env.DB, "priya", { name: null, avatar_url: null, email: "late@example.com" });
    expect((await getPerson(env.DB, "priya"))!.email).toBe("late@example.com");
  });
});

describe("identities", () => {
  it("link, list, find, unlink; the last identity cannot be unlinked", async () => {
    await createPerson(env.DB, { handle: "priya", name: null, color: "plum", avatar_url: null, email: null });
    await linkIdentity(env.DB, { provider: "google", subject: "g-123", label: "priya@example.com", person: "priya", linkedBy: "priya" });
    expect((await findIdentity(env.DB, "google", "g-123"))?.person).toBe("priya");
    expect(await unlinkIdentity(env.DB, "priya", "google")).toBe("last_identity");
    await linkIdentity(env.DB, { provider: "github", subject: "priya-gh", label: "priya-gh", person: "priya", linkedBy: "priya" });
    expect((await listIdentities(env.DB, "priya")).map((i) => i.provider).sort()).toEqual(["github", "google"]);
    expect(await unlinkIdentity(env.DB, "priya", "google")).toBe("ok");
    expect(await unlinkIdentity(env.DB, "priya", "google")).toBe("not_found");
  });
  it("findPersonByEmail is case-insensitive", async () => {
    await createPerson(env.DB, { handle: "priya", name: null, color: "plum", avatar_url: null, email: "Priya@Example.com" });
    expect((await findPersonByEmail(env.DB, "priya@example.com"))?.handle).toBe("priya");
  });
});

describe("updateProfile / listPersons", () => {
  it("updates name and color only; rejects an unknown handle", async () => {
    const before = await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`);
    const after = await updateProfile(env.DB, "AndresL230", { name: "Andrés", color: "rose" });
    expect(after?.name).toBe("Andrés");
    expect(after?.color).toBe("rose");
    expect(after?.created_at).toBe(before?.created_at);
    expect(await updateProfile(env.DB, "nobody", { color: "moss" })).toBeNull();
  });
  it("listPersons returns the seeded four, handle-sorted, with color", async () => {
    const rows = await listPersons(env.DB);
    expect(rows.map((r) => r.handle)).toEqual(["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "lpcooper-arch"]);
    expect(rows[0].color).toBe("moss");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/auth-persons.test.ts`
Expected: FAIL — cannot resolve `../src/auth/persons`.

- [ ] **Step 3: Write `src/auth/persons.ts`**

```ts
import { type DB, first, all, run, nowIso } from "../db";
import { PERSON_COLORS, type PersonColor, type PersonRow, type IdentityRow, type IdentityProvider } from "@shared/rows";

export const HANDLE_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const RESERVED_HANDLES: readonly string[] = ["github-webhook", "system", "admin", "canopy", "me"];
export type HandleProblem = "invalid" | "reserved" | "taken";

export class HandleTakenError extends Error {
  constructor(handle: string) { super(`handle taken: ${handle}`); }
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}

/** Stable color for a migrated/derived person: FNV-1a over the seed, mod the palette. */
export function defaultColor(seed: string): PersonColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

export function getPerson(db: DB, handle: string): Promise<PersonRow | null> {
  return first<PersonRow>(db, `SELECT * FROM persons WHERE handle = ? COLLATE NOCASE`, handle);
}

export function findIdentity(db: DB, provider: IdentityProvider, subject: string): Promise<IdentityRow | null> {
  return first<IdentityRow>(db, `SELECT * FROM identities WHERE provider = ? AND subject = ?`, provider, subject);
}

export function findPersonByEmail(db: DB, email: string): Promise<PersonRow | null> {
  return first<PersonRow>(db, `SELECT * FROM persons WHERE lower(email) = lower(?)`, email);
}

export async function handleAvailable(db: DB, handle: string): Promise<{ available: boolean; reason?: HandleProblem }> {
  if (!isValidHandle(handle)) return { available: false, reason: "invalid" };
  if (RESERVED_HANDLES.includes(handle)) return { available: false, reason: "reserved" };
  if (await getPerson(db, handle)) return { available: false, reason: "taken" };
  return { available: true };
}

/** Every sign-in: refresh name/avatar; write email ONLY when the row has none (0021 rule). */
export async function recordSignIn(db: DB, handle: string, p: { name: string | null; avatar_url: string | null; email: string | null }): Promise<void> {
  await run(db, `UPDATE persons SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url), email = COALESCE(email, ?) WHERE handle = ? COLLATE NOCASE`,
    p.name, p.avatar_url, p.email, handle);
}

export async function createPerson(db: DB, p: { handle: string; name: string | null; color: PersonColor; avatar_url: string | null; email: string | null }): Promise<PersonRow> {
  const now = nowIso();
  try {
    await run(db, `INSERT INTO persons (handle, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      p.handle, p.name, p.color, p.avatar_url, p.email, now, now);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e))) throw new HandleTakenError(p.handle);
    throw e;
  }
  return (await getPerson(db, p.handle))!;
}

export async function linkIdentity(db: DB, i: { provider: IdentityProvider; subject: string; label: string; person: string; linkedBy: string }): Promise<void> {
  await run(db, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?)`,
    i.provider, i.subject, i.label, i.person, nowIso(), i.linkedBy);
}

export async function unlinkIdentity(db: DB, person: string, provider: IdentityProvider): Promise<"ok" | "last_identity" | "not_found"> {
  const mine = await listIdentities(db, person);
  const target = mine.find((i) => i.provider === provider);
  if (!target) return "not_found";
  if (mine.length <= 1) return "last_identity";
  await run(db, `DELETE FROM identities WHERE provider = ? AND subject = ?`, target.provider, target.subject);
  return "ok";
}

export function listIdentities(db: DB, person: string): Promise<IdentityRow[]> {
  return all<IdentityRow>(db, `SELECT * FROM identities WHERE person = ? COLLATE NOCASE ORDER BY linked_at ASC`, person);
}

export async function updateProfile(db: DB, handle: string, patch: { name?: string | null; color?: PersonColor }): Promise<PersonRow | null> {
  const row = await getPerson(db, handle);
  if (!row) return null;
  await run(db, `UPDATE persons SET name = ?, color = ? WHERE handle = ? COLLATE NOCASE`,
    patch.name === undefined ? row.name : patch.name, patch.color ?? row.color, handle);
  return getPerson(db, handle);
}

export function listPersons(db: DB): Promise<Pick<PersonRow, "handle" | "name" | "color" | "avatar_url">[]> {
  return all(db, `SELECT handle, name, color, avatar_url FROM persons ORDER BY handle COLLATE NOCASE ASC`);
}
```

Delete `src/auth/users.ts`.

- [ ] **Step 4: Principal, session, tokens**

`src/auth/principal.ts`: change `Principal` to `{ handle: string }`; `resolveSessionPrincipal` returns `{ handle }` from `getSessionUser`; `sessionGate` DEV branch sets `{ handle: c.env.DEV_LOGIN }`; `PUBLIC_PATHS` becomes:

```ts
const PUBLIC_PATHS = new Set([
  "/auth/login", "/auth/callback",
  "/auth/google/login", "/auth/google/callback",
  "/auth/onboard", "/auth/handle-check", // gate themselves on the onboard cookie
]);
```

`src/auth/session.ts`: `createSession(db, handle)` inserts `(id, person, …)`; `getSessionUser` selects `person` and returns it.
`src/auth/tokens.ts`: `mintToken(db, handle)` inserts `person`; `resolveToken` selects `person` and returns `{ handle: row.person }`.

- [ ] **Step 5: Mechanical rename of `principal.login` → `principal.handle`**

```bash
sed -i 's/c\.get("principal")\.login/c.get("principal").handle/g' src/routes.ts src/notifications/routes.ts src/auth/routes.ts
sed -i 's/principal\.login/principal.handle/g' src/mcp.ts src/consumer.ts
```

In `src/auth/routes.ts`: replace `import { recordLogin } from "./users";` with `import { recordSignIn, getPerson } from "./persons";` and change the callback line to `await recordSignIn(c.env.DB, ghUser.login, { name: ghUser.name, avatar_url: ghUser.avatar_url, email: await getPrimaryEmail(token) });` (Task 6 replaces this whole callback with the fork; this keeps it compiling now). Change `/me` to:

```ts
authApp.get("/me", async (c) => {
  const handle = c.get("principal").handle;
  const row = await getPerson(c.env.DB, handle);
  return c.json({ handle, name: row?.name ?? null, avatar_url: row?.avatar_url ?? null, color: row?.color ?? "stone", org: SAPLING_ORG, admin: isAdmin(c.env, handle) });
});
```

- [ ] **Step 6: Test helper**

`test/helpers/persons.ts`:

```ts
import { env } from "cloudflare:test";
import { run } from "../../src/db";
import { createSession } from "../../src/auth/session";
import { hmacSeal } from "../../src/auth/crypto";
import type { PersonColor } from "@shared/rows";

export interface SeedPersonOpts { name?: string | null; email?: string | null; unsubscribed?: 0 | 1; color?: PersonColor; avatar_url?: string | null; github?: boolean }

/** Upsert a person (and, by default, its github identity = handle). Idempotent. */
export async function seedPerson(handle: string, o: SeedPersonOpts = {}): Promise<void> {
  await run(env.DB, `INSERT OR IGNORE INTO persons (handle, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    handle, o.name === undefined ? handle : o.name, o.color ?? "stone", o.avatar_url ?? null, o.email ?? null, o.unsubscribed ?? 0);
  if (o.github !== false) {
    await run(env.DB, `INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', ?, ?, ?, '2026-01-01T00:00:00Z', 'seed')`, handle, handle, handle);
  }
}

/** A signed session cookie for `handle`, seeding the person if needed. */
export async function cookieFor(handle: string, o: SeedPersonOpts = {}): Promise<string> {
  await seedPerson(handle, o);
  const { id } = await createSession(env.DB, handle);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}
```

- [ ] **Step 7: Update the six auth tests**

- `test/auth-email-seed.test.ts`: replace the `recordLogin` describe with `recordSignIn` over a seeded person (`seedPerson("jose", { email: null })`, then the same three assertions using `getPerson`); keep the `getPrimaryEmail` describe.
- `test/auth-me.test.ts`: replace `authedCookie` with `cookieFor` from the helper (`cookieFor("andres")`, `cookieFor("jose", { avatar_url: url })`); assert `body.handle` instead of `body.login`, and add `expect(body.color).toBe("stone")`.
- `test/auth-session.test.ts`, `test/auth-tokens.test.ts`, `test/auth-principal.test.ts`: wherever they insert into `users`, call `seedPerson(login)` instead; wherever they read `sessions.user` / `mcp_tokens.user`, read `.person`; `resolveToken` now returns `{ handle }`.
- `test/auth-routes.test.ts`: delete the "users schema" describe (the table no longer exists).

- [ ] **Step 8: Run the auth tests**

Run: `npx vitest run test/auth-persons.test.ts test/auth-email-seed.test.ts test/auth-me.test.ts test/auth-session.test.ts test/auth-tokens.test.ts test/auth-principal.test.ts test/auth-routes.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A src/auth shared test/helpers test/auth-*.test.ts src/mcp.ts src/consumer.ts src/routes.ts src/notifications/routes.ts
git commit -m "feat(identity): persons module, Principal.handle, sessions/tokens on persons"
```

---

### Task 3: Readers and writers off `people` and `users`

**Files:**
- Modify: `src/tools/mywork.ts`, `src/tools/writes.ts` (`ensure_identity_task`, `map_identity`), `src/notifications/renderers/my-work.ts`, `src/notifications/run.ts:124-127`, `src/notifications/retry.ts:33`, `src/notifications/routes.ts` (`prefsView`, PUT `/prefs`, `/users/:login` → `/persons/:handle`, `/test-send`), `src/index.ts:45`
- Test: `test/identity-map.test.ts`, `test/mywork.test.ts`, `test/identity-routes.test.ts`, `test/notifications.run.test.ts`, `test/notifications.routes.test.ts`

**Interfaces:**
- Consumes: `getPerson`, `findIdentity`, `linkIdentity` from Task 2.
- Produces: `resolvePersonForLogin(db, login): Promise<PersonRow | null>` exported from `src/tools/mywork.ts` (the one place a GitHub login becomes a person).
- Changes: `map_identity(db, login, personHandle, by)` now requires an existing person and inserts an `identities` row.

- [ ] **Step 1: Update `test/identity-map.test.ts` to the new contract**

Replace the file body's assertions: map to a seeded handle, expect an identities row.

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { map_identity } from "../src/tools/writes";
import { seedPerson } from "./helpers/persons";
import type { IdentityTaskRow, IdentityRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:7:merged", event_type: "pr_merged", ref_number: 7, subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "t", body: "b" } }), provenance: "webhook", occurred_at: "2026-07-01T10:00:00Z", ...over,
});

describe("map_identity — the identities table's human write path", () => {
  it("links the login to an existing person and soft-resolves the task", async () => {
    await seedPerson("casey");
    await ingestEvent(env.DB, ev(), "github-webhook");
    const res = await map_identity(env.DB, "mystery-dev", "casey", "andres");
    expect(res).toEqual({ login: "mystery-dev", person: "casey", status: "resolved" });
    const id = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'github' AND subject = 'mystery-dev'`);
    expect(id?.person).toBe("casey");
    expect(id?.linked_by).toBe("andres");
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task?.status).toBe("resolved");
    expect(task?.resolved_by).toBe("andres");
  });
  it("double-map is idempotent-safe: the first mapping stands", async () => {
    await seedPerson("casey"); await seedPerson("other");
    await ingestEvent(env.DB, ev(), "github-webhook");
    await map_identity(env.DB, "mystery-dev", "casey", "andres");
    const second = await map_identity(env.DB, "mystery-dev", "other", "jose");
    expect(second).toEqual({ login: "mystery-dev", person: "casey", status: "resolved" });
    expect((await all(env.DB, `SELECT * FROM identities WHERE subject = 'mystery-dev'`)).length).toBe(1);
  });
  it("throws on a login with no identity task, and on an unknown person", async () => {
    await expect(map_identity(env.DB, "nobody-here", "casey", "andres")).rejects.toThrow("no such identity task: nobody-here");
    await ingestEvent(env.DB, ev(), "github-webhook");
    await expect(map_identity(env.DB, "mystery-dev", "ghost", "andres")).rejects.toThrow("no such person: ghost");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'mystery-dev'`)).toBeNull();
  });
  it("a login already linked never raises a task", async () => {
    await ingestEvent(env.DB, ev({ subject_login: "AndresL230", semantic_key: "gh:pr:8:merged", ref_number: 8 }), "github-webhook");
    expect(await first(env.DB, `SELECT 1 AS x FROM identity_tasks WHERE login = 'AndresL230'`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/identity-map.test.ts`
Expected: FAIL (`no such table: people`).

- [ ] **Step 3: Rewrite the two writers in `src/tools/writes.ts`**

Replace the `PersonRow` import with `import { getPerson, findIdentity, linkIdentity } from "../auth/persons";` and:

```ts
export async function ensure_identity_task(db: DB, login: string): Promise<void> {
  try {
    if (login.endsWith("[bot]")) return;
    if (await findIdentity(db, "github", login)) return;
    await run(db, `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES (?, ?, 'pending')`, login, nowIso());
  } catch { /* never throw — post-capture side task */ }
}

/** Human placement: link a GitHub login to an EXISTING person (by handle), then soft-resolve the task. */
export async function map_identity(db: DB, login: string, personHandle: string, by: string): Promise<{ login: string; person: string; status: "resolved" }> {
  const task = await first<IdentityTaskRow>(db, `SELECT * FROM identity_tasks WHERE login = ?`, login);
  if (!task) throw new Error(`no such identity task: ${login}`);
  if (task.status === "resolved") {
    const existing = await findIdentity(db, "github", login);
    return { login, person: existing?.person ?? personHandle, status: "resolved" };
  }
  const person = await getPerson(db, personHandle);
  if (!person) throw new Error(`no such person: ${personHandle}`);
  await linkIdentity(db, { provider: "github", subject: login, label: login, person: person.handle, linkedBy: by });
  await run(db, `UPDATE identity_tasks SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE login = ?`, nowIso(), by, login);
  return { login, person: person.handle, status: "resolved" };
}
```

- [ ] **Step 4: My Work resolves through identities**

In `src/tools/mywork.ts` replace the `PersonRow` import with `import type { EventRow, PersonRow } from "@shared/rows";` (same name, new shape) and add:

```ts
/** The person a GitHub login belongs to, via the github identity row; null when unmapped. */
export async function resolvePersonForLogin(db: DB, login: string): Promise<PersonRow | null> {
  return first<PersonRow>(db,
    `SELECT p.* FROM identities i JOIN persons p ON p.handle = i.person WHERE i.provider = 'github' AND i.subject = ?`, login);
}
```

`getMyWork(db, handle)` becomes: load `const me = await getPerson(db, handle)` (import from `../auth/persons`); if null → `EMPTY(false)`; then `const logins = (await listIdentities(db, handle)).filter((i) => i.provider === "github").map((i) => i.subject)`; if `logins.length === 0` → `{ person: me.name ?? me.handle, previousActivity: [], todo: [], degraded: false }`; the PR query uses `AND e.subject_login IN (${logins.map(() => "?").join(",")})` with `...logins`; `listOpenAssignedIssues` gains a `logins: string[]` parameter and matches `issue.assignees.some((a) => logins.includes(a.login))`; `person` is `me.name ?? me.handle`. Update the one other caller of `listOpenAssignedIssues` (the my-work renderer, next step).

- [ ] **Step 5: Notifications off `users`/`people`**

- `src/notifications/renderers/my-work.ts`: `render(db, handle, window)` → `const me = await getPerson(db, handle); if (!me) return null; const logins = (await listIdentities(db, handle)).filter(i => i.provider === "github").map(i => i.subject); if (!logins.length) return null;` PR query uses `IN (…)`; `listOpenAssignedIssues(db, logins)`.
- `src/notifications/run.ts:124-127`: `SELECT handle AS github_login, email FROM persons WHERE email IS NOT NULL AND email != '' AND email_unsubscribed = 0 ORDER BY handle` (keeping the `Recipient` field name avoids touching the rest of the loop).
- `src/notifications/retry.ts:33`: `SELECT handle AS github_login, email, email_unsubscribed FROM persons WHERE handle = ?`.
- `src/notifications/routes.ts`: `prefsView` reads `persons` (`PersonRow`); PUT `/prefs` updates `persons … WHERE handle = ?`; rename `/users/:login` → `/persons/:handle` (route, adminOnly path `"/persons/*"`, `UPDATE persons SET email = ? WHERE handle = ?`, response key `handle`); `/test-send` reads `persons`.
- `src/index.ts:45`: `UPDATE persons SET email_unsubscribed = 1 WHERE handle = ?`.
- `web/src/api.ts` and `web/src/notifications.ts`: `grep -n "notifications/users" web/src` returned nothing, so no web change here.

- [ ] **Step 6: Update the affected tests**

- `test/mywork.test.ts`, `test/identity-routes.test.ts`, `test/dashboard-route.test.ts`, `test/mcp.mywork.test.ts`: any `INSERT … INTO users` becomes `seedPerson(login)`; any `people` insert becomes `seedPerson(handle)` + (for an alias login) `run(env.DB, "INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', ?, ?, ?, 't', 'test')", alias, alias, handle)`; `getMyWork(db, "AndresL230")` still returns `person: "Andres"` (seeded name).
- `test/notifications.run.test.ts`: the `user()` helper becomes `seedPerson(login, { name: login, email, unsubscribed })`.
- `test/notifications.routes.test.ts`: `/api/notifications/users/<login>` → `/api/notifications/persons/<handle>`; response `handle`.
- `test/notifications.cron.test.ts`, `test/notifications.preview.test.ts`, `test/notifications.resend.test.ts`: same `users` insert → `seedPerson`.

- [ ] **Step 7: Run them**

Run: `npx vitest run test/identity-map.test.ts test/mywork.test.ts test/identity-routes.test.ts test/dashboard-route.test.ts test/mcp.mywork.test.ts test/notifications.run.test.ts test/notifications.routes.test.ts test/notifications.cron.test.ts test/notifications.preview.test.ts test/notifications.resend.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "refactor(identity): readers/writers resolve through identities + persons"
```

---

### Task 4: Whole suite green

**Files:**
- Modify: every remaining test that inserts into `users`/`people` (from the Task-3 grep list): `test/admin-route.test.ts`, `test/doc-promote-adr-ratify.test.ts`, `test/events-schema.test.ts`, `test/fts-isolation.test.ts`, `test/identity-schema.test.ts`, `test/ingest.route.test.ts`, `test/notifications.schema.test.ts`, `test/query.mcp-route.test.ts`, `test/query.roadmap.test.ts`, `test/record-session.mcp.test.ts`, `test/roadmap.test.ts`, `test/triage-reads.test.ts`, `test/triage-writeback.test.ts`, `test/seed-coverage.test.ts`
- Modify: `test/env.d.ts` (add `GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; PUBLIC_ORIGIN?: string; NOTIFICATIONS_MODE?: string;`), `src/env.ts` (add `GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;`), `vitest.config.ts` (bindings `GOOGLE_CLIENT_ID: "test-google-client-id", GOOGLE_CLIENT_SECRET: "test-google-secret", PUBLIC_ORIGIN: "https://canopy.test"`)

- [ ] **Step 1: Sweep**

```bash
grep -rln -e "INTO users" -e "FROM users" -e "INTO people" -e "FROM people" test
```

For each file: replace the local `authedCookie`/`cookieFor` helper body with `import { cookieFor } from "./helpers/persons";` (delete the local function), replace raw `INSERT … INTO users (…)` calls with `await seedPerson(login)`, and replace `people` reads with `identities`/`persons`. `test/identity-schema.test.ts` and `test/seed-coverage.test.ts` assert table shapes: update them to expect `persons`, `identities`, `invites` and no `users`/`people`.

- [ ] **Step 2: Full run + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green (except the environmental Gemini test if `.dev.vars` has a key).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(identity): suite on persons/identities; Google env bindings"
```

---

### Task 5: Google provider — authorize URL, code exchange, ID-token verification

**Files:**
- Create: `src/auth/google.ts`
- Modify: `src/auth/crypto.ts` (export `b64uEncode`, `b64uDecode`, `b64uToBytes`)
- Modify: `src/auth/github.ts` (optional `fetchImpl` on `exchangeCode`, `getUser`, `isActiveOrgMember`)
- Test: `test/auth-google.test.ts`, `test/helpers/google.ts`

**Interfaces:**
- Produces `src/auth/google.ts`:
  ```ts
  export interface GoogleProfile { sub: string; email: string; email_verified: boolean; name: string | null; picture: string | null }
  export function buildGoogleAuthorizeUrl(o: { clientId; redirectUri; state; challenge; loginHint?: string; prompt?: string }): string;
  export async function exchangeGoogleCode(o: { env; code; redirectUri; verifier; fetchImpl? }): Promise<string | null>; // the id_token
  export async function verifyGoogleIdToken(idToken: string, o: { clientId: string; fetchImpl?: typeof fetch; now?: () => number }): Promise<GoogleProfile | null>;
  ```
- Produces `src/auth/crypto.ts`: `b64uEncode(s: string): string`, `b64uDecode(s: string): string`, `b64uToBytes(s: string): Uint8Array`.
- Produces `test/helpers/google.ts`: `makeGoogleKeys()`, `signIdToken(keys, claims)`, `googleFetch(keys, opts)` — a `fetchImpl` that serves the JWKS and the token endpoint.

- [ ] **Step 1: Test helper for a fake Google**

`test/helpers/google.ts`:

```ts
import { b64uEncode } from "../../src/auth/crypto";

export interface GoogleKeys { priv: CryptoKey; jwk: JsonWebKey & { kid: string } }

const enc = new TextEncoder();
const b64uBytes = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function makeGoogleKeys(kid = "kid-1"): Promise<GoogleKeys> {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { priv: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export const CLAIMS = {
  iss: "https://accounts.google.com", aud: "test-google-client-id", sub: "g-123", email: "priya.n@gmail.com", email_verified: true,
  name: "Priya Natarajan", picture: "https://lh3/p.png", iat: 1_800_000_000, exp: 1_800_003_600,
};

export async function signIdToken(keys: GoogleKeys, claims: Record<string, unknown>, kid = keys.jwk.kid): Promise<string> {
  const h = b64uEncode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64uEncode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.priv, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64uBytes(sig)}`;
}

/** fetchImpl serving Google's JWKS and token endpoint. Records token-endpoint bodies. */
export function googleFetch(keys: GoogleKeys, o: { idToken?: string; tokenStatus?: number } = {}) {
  const tokenCalls: URLSearchParams[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return new Response(JSON.stringify({ keys: [keys.jwk] }), { headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(JSON.stringify({ id_token: o.idToken ?? "", access_token: "at" }), { status: o.tokenStatus ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected fetch " + u, { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, tokenCalls };
}
```

- [ ] **Step 2: Write the failing provider test**

`test/auth-google.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode, verifyGoogleIdToken } from "../src/auth/google";
import { makeGoogleKeys, signIdToken, googleFetch, CLAIMS } from "./helpers/google";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";

const NOW = () => 1_800_000_100_000; // ms, inside [iat, exp]

describe("buildGoogleAuthorizeUrl", () => {
  it("targets accounts.google.com with PKCE, openid scopes, and passes login_hint/prompt through", () => {
    const u = new URL(buildGoogleAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/auth/google/callback", state: "st", challenge: "ch", loginHint: "a@b.c", prompt: "select_account" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("ch");
    expect(u.searchParams.get("login_hint")).toBe("a@b.c");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("exchangeGoogleCode", () => {
  it("POSTs the PKCE verifier and returns the id_token; null on non-2xx", async () => {
    const keys = await makeGoogleKeys();
    const { fetchImpl, tokenCalls } = googleFetch(keys, { idToken: "tok" });
    const id = await exchangeGoogleCode({ env: env as unknown as Env, code: "c", redirectUri: "https://x/cb", verifier: "v", fetchImpl });
    expect(id).toBe("tok");
    expect(tokenCalls[0].get("code_verifier")).toBe("v");
    expect(tokenCalls[0].get("grant_type")).toBe("authorization_code");
    const bad = googleFetch(keys, { tokenStatus: 400 });
    expect(await exchangeGoogleCode({ env: env as unknown as Env, code: "c", redirectUri: "https://x/cb", verifier: "v", fetchImpl: bad.fetchImpl })).toBeNull();
  });
});

describe("verifyGoogleIdToken", () => {
  it("accepts a well-formed token signed by the JWKS key", async () => {
    const keys = await makeGoogleKeys();
    const tok = await signIdToken(keys, CLAIMS);
    const p = await verifyGoogleIdToken(tok, { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW });
    expect(p).toEqual({ sub: "g-123", email: "priya.n@gmail.com", email_verified: true, name: "Priya Natarajan", picture: "https://lh3/p.png" });
  });
  it.each([
    ["bad iss", { iss: "https://evil.example" }],
    ["bad aud", { aud: "other-client" }],
    ["expired", { exp: 1_700_000_000 }],
  ])("rejects %s", async (_label, over) => {
    const keys = await makeGoogleKeys();
    const tok = await signIdToken(keys, { ...CLAIMS, ...over });
    expect(await verifyGoogleIdToken(tok, { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW })).toBeNull();
  });
  it("rejects a token signed by another key and an unknown kid", async () => {
    const keys = await makeGoogleKeys();
    const other = await makeGoogleKeys("kid-1"); // same kid, different key
    expect(await verifyGoogleIdToken(await signIdToken(other, CLAIMS), { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW })).toBeNull();
    expect(await verifyGoogleIdToken(await signIdToken(keys, CLAIMS, "kid-unknown"), { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW })).toBeNull();
  });
  it("returns email_verified:false verbatim (the caller gates on it) and accepts the bare 'accounts.google.com' issuer", async () => {
    const keys = await makeGoogleKeys();
    const tok = await signIdToken(keys, { ...CLAIMS, iss: "accounts.google.com", email_verified: false });
    expect((await verifyGoogleIdToken(tok, { clientId: "test-google-client-id", fetchImpl: googleFetch(keys).fetchImpl, now: NOW }))?.email_verified).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/auth-google.test.ts`
Expected: FAIL — cannot resolve `../src/auth/google` / `b64uEncode`.

- [ ] **Step 4: crypto helpers**

Append to `src/auth/crypto.ts`:

```ts
/** UTF-8 string → base64url (dot-free; safe inside hmacSeal values). */
export function b64uEncode(s: string): string {
  return toBase64Url(enc.encode(s));
}
export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64uDecode(s: string): string {
  return new TextDecoder().decode(b64uToBytes(s));
}
```

- [ ] **Step 5: Write `src/auth/google.ts`**

```ts
import type { Env } from "../env";
import { b64uDecode, b64uToBytes } from "./crypto";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleProfile { sub: string; email: string; email_verified: boolean; name: string | null; picture: string | null }

export function buildGoogleAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string; prompt?: string }): string {
  const u = new URL(AUTHORIZE);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (o.loginHint) u.searchParams.set("login_hint", o.loginHint);
  if (o.prompt) u.searchParams.set("prompt", o.prompt);
  return u.toString();
}

/** Exchange the code (+ PKCE verifier) for the ID token; null on failure. */
export async function exchangeGoogleCode(o: { env: Env; code: string; redirectUri: string; verifier: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const f = o.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: o.env.GOOGLE_CLIENT_ID ?? "", client_secret: o.env.GOOGLE_CLIENT_SECRET ?? "",
    code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier, grant_type: "authorization_code",
  });
  const res = await f(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!res.ok) return null;
  const data = (await res.json()) as { id_token?: string };
  return data.id_token ?? null;
}

interface Jwk { kid?: string; kty: string; n: string; e: string; alg?: string }

/** Verify signature (RS256 against Google's JWKS), iss, aud, exp. Returns the profile claims or null. */
export async function verifyGoogleIdToken(idToken: string, o: { clientId: string; fetchImpl?: typeof fetch; now?: () => number }): Promise<GoogleProfile | null> {
  const f = o.fetchImpl ?? fetch;
  const now = (o.now ?? Date.now)();
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64uDecode(parts[0]));
    claims = JSON.parse(b64uDecode(parts[1]));
  } catch { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;

  const res = await f(JWKS, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;

  if (!ISSUERS.has(String(claims.iss))) return null;
  if (claims.aud !== o.clientId) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") return null;
  return {
    sub: claims.sub, email: claims.email, email_verified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
  };
}
```

- [ ] **Step 6: GitHub fetch injection**

In `src/auth/github.ts` add `fetchImpl: typeof fetch = fetch` as the last parameter of `getUser(token, fetchImpl = fetch)` and `isActiveOrgMember(token, fetchImpl = fetch)`, and `fetchImpl?: typeof fetch` in `exchangeCode`'s options; use it in place of `fetch` in each.

- [ ] **Step 7: Run**

Run: `npx vitest run test/auth-google.test.ts test/auth-github.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/auth/google.ts src/auth/crypto.ts src/auth/github.ts test/auth-google.test.ts test/helpers/google.ts
git commit -m "feat(auth): Google provider — PKCE authorize, code exchange, JWKS-verified ID token"
```

---

### Task 6: The sign-in fork, the onboarding cookie, and `buildAuthApp`

**Files:**
- Create: `src/auth/onboard.ts`, `src/auth/invites.ts`
- Modify: `src/auth/routes.ts` (wrap in `buildAuthApp(deps)`; GitHub callback runs the fork; add onboard routes)
- Test: `test/auth-fork.test.ts`, `test/auth-onboard.test.ts`, `test/auth-invites.test.ts`

**Interfaces:**
- Produces `src/auth/invites.ts`:
  ```ts
  export async function createInvite(db, i: { email; name: string | null; invitedBy }): Promise<InviteRow>;          // throws "invite_exists" | "already_a_person"
  export async function findLiveInvite(db, email): Promise<InviteRow | null>;  // lowercased; revoked_at IS NULL AND accepted_by IS NULL
  export async function acceptInvite(db, email, handle): Promise<void>;
  export async function revokeInvite(db, email): Promise<boolean>;             // false when no row
  export async function listInvites(db): Promise<InviteRow[]>;                 // invited_at DESC
  export async function recordInviteEmail(db, email, r: { id: string | null; error: string | null }): Promise<void>;
  ```
- Produces `src/auth/onboard.ts`:
  ```ts
  export interface ProviderProfile { provider: IdentityProvider; subject: string; label: string; email: string | null; name: string | null; avatar_url: string | null }
  export interface OnboardPayload extends ProviderProfile { suggested_handle: string; invite_email: string | null }
  export const ONBOARD_COOKIE = "onboard";
  export function suggestHandle(p: ProviderProfile): string;
  export async function sealOnboard(payload: OnboardPayload, secret): Promise<string>;   // hmacSeal(b64uEncode(JSON))
  export async function openOnboard(sealed: string, secret): Promise<OnboardPayload | null>;
  export type ForkResult = { kind: "session"; handle: string } | { kind: "onboard"; payload: OnboardPayload } | { kind: "denied" };
  export async function completeSignIn(db, p: ProviderProfile): Promise<ForkResult>;  // the fork
  export async function linkSignIn(db, handle: string, p: ProviderProfile): Promise<"linked" | "belongs_to_other">;
  ```
- Produces `src/auth/routes.ts`: `export interface AuthDeps { fetchImpl?: typeof fetch; now?: () => number }`, `export function buildAuthApp(deps: AuthDeps = {}): Hono<AppEnv>`, `export const authApp = buildAuthApp()`.

- [ ] **Step 1: Failing invites test**

`test/auth-invites.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createInvite, findLiveInvite, acceptInvite, revokeInvite, listInvites, recordInviteEmail } from "../src/auth/invites";
import { seedPerson } from "./helpers/persons";

describe("invites", () => {
  it("creates lowercased, finds live, accepts, and stops being live", async () => {
    const row = await createInvite(env.DB, { email: "Priya.N@Gmail.com", name: "Priya", invitedBy: "AndresL230" });
    expect(row.email).toBe("priya.n@gmail.com");
    expect((await findLiveInvite(env.DB, "PRIYA.n@gmail.com"))?.email).toBe("priya.n@gmail.com");
    await acceptInvite(env.DB, "priya.n@gmail.com", "priya");
    expect(await findLiveInvite(env.DB, "priya.n@gmail.com")).toBeNull();
    expect((await listInvites(env.DB))[0].accepted_by).toBe("priya");
  });
  it("revoke is soft and idempotent; a revoked invite is not live", async () => {
    await createInvite(env.DB, { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    expect(await revokeInvite(env.DB, "m@x.io")).toBe(true);
    expect(await revokeInvite(env.DB, "m@x.io")).toBe(true);
    expect(await revokeInvite(env.DB, "none@x.io")).toBe(false);
    expect(await findLiveInvite(env.DB, "m@x.io")).toBeNull();
    expect((await listInvites(env.DB))[0].revoked_at).toBeTruthy();
  });
  it("refuses a duplicate live invite and an address that is already a person's", async () => {
    await createInvite(env.DB, { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    await expect(createInvite(env.DB, { email: "m@x.io", name: null, invitedBy: "AndresL230" })).rejects.toThrow("invite_exists");
    await seedPerson("priya", { email: "priya@x.io" });
    await expect(createInvite(env.DB, { email: "Priya@x.io", name: null, invitedBy: "AndresL230" })).rejects.toThrow("already_a_person");
  });
  it("a revoked invite can be re-invited (row is replaced, revoked_at cleared)", async () => {
    await createInvite(env.DB, { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    await revokeInvite(env.DB, "m@x.io");
    const again = await createInvite(env.DB, { email: "m@x.io", name: "M", invitedBy: "AndresL230" });
    expect(again.revoked_at).toBeNull();
    expect(again.name).toBe("M");
  });
  it("recordInviteEmail stores the outcome", async () => {
    await createInvite(env.DB, { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    await recordInviteEmail(env.DB, "m@x.io", { id: "em_1", error: null });
    const r = (await listInvites(env.DB))[0];
    expect(r.email_id).toBe("em_1"); expect(r.email_sent_at).toBeTruthy(); expect(r.email_error).toBeNull();
  });
});
```

- [ ] **Step 2: Write `src/auth/invites.ts`**

```ts
import { type DB, first, all, run, nowIso } from "../db";
import type { InviteRow } from "@shared/rows";
import { findPersonByEmail } from "./persons";

const norm = (e: string) => e.trim().toLowerCase();

export async function findLiveInvite(db: DB, email: string): Promise<InviteRow | null> {
  return first<InviteRow>(db, `SELECT * FROM invites WHERE email = ? AND revoked_at IS NULL AND accepted_by IS NULL`, norm(email));
}

export async function createInvite(db: DB, i: { email: string; name: string | null; invitedBy: string }): Promise<InviteRow> {
  const email = norm(i.email);
  if (await findPersonByEmail(db, email)) throw new Error("already_a_person");
  if (await findLiveInvite(db, email)) throw new Error("invite_exists");
  await run(db,
    `INSERT INTO invites (email, name, invited_by, invited_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, invited_by = excluded.invited_by, invited_at = excluded.invited_at,
       accepted_by = NULL, revoked_at = NULL, email_sent_at = NULL, email_id = NULL, email_error = NULL`,
    email, i.name, i.invitedBy, nowIso());
  return (await first<InviteRow>(db, `SELECT * FROM invites WHERE email = ?`, email))!;
}

export async function acceptInvite(db: DB, email: string, handle: string): Promise<void> {
  await run(db, `UPDATE invites SET accepted_by = ? WHERE email = ? AND accepted_by IS NULL`, handle, norm(email));
}

export async function revokeInvite(db: DB, email: string): Promise<boolean> {
  const row = await first<InviteRow>(db, `SELECT * FROM invites WHERE email = ?`, norm(email));
  if (!row) return false;
  if (!row.revoked_at) await run(db, `UPDATE invites SET revoked_at = ? WHERE email = ?`, nowIso(), row.email);
  return true;
}

export function listInvites(db: DB): Promise<InviteRow[]> {
  return all<InviteRow>(db, `SELECT * FROM invites ORDER BY invited_at DESC, email ASC`);
}

export async function recordInviteEmail(db: DB, email: string, r: { id: string | null; error: string | null }): Promise<void> {
  await run(db, `UPDATE invites SET email_sent_at = ?, email_id = ?, email_error = ? WHERE email = ?`, nowIso(), r.id, r.error, norm(email));
}
```

- [ ] **Step 3: Failing fork test**

`test/auth-fork.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first } from "../src/db";
import { completeSignIn, linkSignIn, suggestHandle, sealOnboard, openOnboard, type ProviderProfile } from "../src/auth/onboard";
import { createInvite } from "../src/auth/invites";
import { seedPerson } from "./helpers/persons";
import type { IdentityRow, PersonRow } from "@shared/rows";

const google = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "google", subject: "g-123", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: "https://lh3/p.png", ...over,
});
const github = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "github", subject: "newdev", label: "newdev", email: "newdev@example.com", name: "New Dev", avatar_url: null, ...over,
});

describe("completeSignIn — the fork", () => {
  it("1. known identity → session; name/avatar refreshed, email COALESCEd", async () => {
    const r = await completeSignIn(env.DB, github({ subject: "AndresL230", label: "AndresL230", name: "Andrés L", email: "x@y.z" }));
    expect(r).toEqual({ kind: "session", handle: "AndresL230" });
    const p = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`))!;
    expect(p.name).toBe("Andrés L");
    expect(p.email).toBe("x@y.z"); // was NULL in the seed → filled
  });
  it("2. unknown identity, verified email matches a person → linked + session, no onboarding", async () => {
    await seedPerson("priya", { email: "priya.n@gmail.com", github: true });
    const r = await completeSignIn(env.DB, google());
    expect(r).toEqual({ kind: "session", handle: "priya" });
    const id = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'google' AND subject = 'g-123'`);
    expect(id?.person).toBe("priya");
    expect(id?.linked_by).toBe("priya");
  });
  it("3a. unknown Google identity with a live invite → onboard payload (nothing written)", async () => {
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: "Priya", invitedBy: "AndresL230" });
    const r = await completeSignIn(env.DB, google());
    expect(r.kind).toBe("onboard");
    if (r.kind !== "onboard") throw new Error();
    expect(r.payload.suggested_handle).toBe("priya-n");
    expect(r.payload.invite_email).toBe("priya.n@gmail.com");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-123'`)).toBeNull();
    expect(await first(env.DB, `SELECT 1 AS x FROM persons WHERE handle = 'priya-n'`)).toBeNull();
  });
  it("3b. unknown GitHub identity (org member) → onboard with the login as suggested handle, no invite needed", async () => {
    const r = await completeSignIn(env.DB, github());
    expect(r.kind).toBe("onboard");
    if (r.kind !== "onboard") throw new Error();
    expect(r.payload.suggested_handle).toBe("newdev");
    expect(r.payload.invite_email).toBeNull();
  });
  it("4. unknown Google identity, no match, no invite (or revoked) → denied", async () => {
    expect(await completeSignIn(env.DB, google())).toEqual({ kind: "denied" });
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    await env.DB.prepare(`UPDATE invites SET revoked_at = 't' WHERE email = 'priya.n@gmail.com'`).run();
    expect(await completeSignIn(env.DB, google())).toEqual({ kind: "denied" });
  });
  it("a null email never auto-links", async () => {
    await seedPerson("priya", { email: null });
    expect(await completeSignIn(env.DB, google({ email: null }))).toEqual({ kind: "denied" });
  });
});

describe("linkSignIn", () => {
  it("attaches a free identity to the caller; refuses one that belongs to someone else", async () => {
    await seedPerson("priya");
    expect(await linkSignIn(env.DB, "AndresL230", google())).toBe("linked");
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'g-123'`))?.person).toBe("AndresL230");
    expect(await linkSignIn(env.DB, "priya", google())).toBe("belongs_to_other");
  });
});

describe("suggestHandle + onboard cookie", () => {
  it("github → the login lowercased; google → local part in the handle alphabet", () => {
    expect(suggestHandle(github({ subject: "NewDev" }))).toBe("newdev");
    expect(suggestHandle(google({ email: "Priya.N+x@gmail.com" }))).toBe("priya-n-x");
    expect(suggestHandle(google({ email: "9lives@x.io" }))).toBe("p-9lives");
  });
  it("seal/open round-trips and rejects tampering", async () => {
    const payload = { ...google(), suggested_handle: "priya-n", invite_email: "priya.n@gmail.com" };
    const sealed = await sealOnboard(payload, "s");
    expect(await openOnboard(sealed, "s")).toEqual(payload);
    expect(await openOnboard(sealed + "x", "s")).toBeNull();
    expect(await openOnboard(sealed, "other")).toBeNull();
  });
});
```

- [ ] **Step 4: Write `src/auth/onboard.ts`**

```ts
import type { DB } from "../db";
import type { IdentityProvider } from "@shared/rows";
import { hmacSeal, hmacUnseal, b64uEncode, b64uDecode } from "./crypto";
import { findIdentity, findPersonByEmail, linkIdentity, recordSignIn, isValidHandle } from "./persons";
import { findLiveInvite } from "./invites";

export interface ProviderProfile { provider: IdentityProvider; subject: string; label: string; email: string | null; name: string | null; avatar_url: string | null }
export interface OnboardPayload extends ProviderProfile { suggested_handle: string; invite_email: string | null }
export const ONBOARD_COOKIE = "onboard";
export const ONBOARD_TTL_S = 600;

export type ForkResult = { kind: "session"; handle: string } | { kind: "onboard"; payload: OnboardPayload } | { kind: "denied" };

/** github → login lowercased; otherwise the email local part squeezed into the handle alphabet. */
export function suggestHandle(p: ProviderProfile): string {
  const raw = p.provider === "github" ? p.subject : (p.email ?? p.label).split("@")[0];
  let h = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  if (!/^[a-z]/.test(h)) h = `p-${h}`.slice(0, 24);
  return isValidHandle(h) ? h : "me-" + Math.random().toString(36).slice(2, 8);
}

export function sealOnboard(payload: OnboardPayload, secret: string): Promise<string> {
  return hmacSeal(b64uEncode(JSON.stringify(payload)), `onboard:${secret}`);
}
export async function openOnboard(sealed: string, secret: string): Promise<OnboardPayload | null> {
  const v = await hmacUnseal(sealed, `onboard:${secret}`);
  if (!v) return null;
  try { return JSON.parse(b64uDecode(v)) as OnboardPayload; } catch { return null; }
}

/**
 * The fork both callbacks run after their provider gate passed.
 * 1 known identity → session. 2 verified email matches a person → link + session.
 * 3 live invite (Google) / org member (GitHub) → onboard. 4 otherwise → denied.
 */
export async function completeSignIn(db: DB, p: ProviderProfile): Promise<ForkResult> {
  const known = await findIdentity(db, p.provider, p.subject);
  if (known) {
    await recordSignIn(db, known.person, { name: p.name, avatar_url: p.avatar_url, email: p.email });
    return { kind: "session", handle: known.person };
  }
  if (p.email) {
    const byEmail = await findPersonByEmail(db, p.email);
    if (byEmail) {
      await linkIdentity(db, { provider: p.provider, subject: p.subject, label: p.label, person: byEmail.handle, linkedBy: byEmail.handle });
      await recordSignIn(db, byEmail.handle, { name: p.name, avatar_url: p.avatar_url, email: p.email });
      return { kind: "session", handle: byEmail.handle };
    }
  }
  const invite = p.email ? await findLiveInvite(db, p.email) : null;
  if (p.provider === "github" || invite) {
    return { kind: "onboard", payload: { ...p, name: p.name ?? invite?.name ?? null, suggested_handle: suggestHandle(p), invite_email: invite?.email ?? null } };
  }
  return { kind: "denied" };
}

/** Link mode: attach the identity to the signed-in person unless someone else already owns it. */
export async function linkSignIn(db: DB, handle: string, p: ProviderProfile): Promise<"linked" | "belongs_to_other"> {
  const known = await findIdentity(db, p.provider, p.subject);
  if (known) return known.person.toLowerCase() === handle.toLowerCase() ? "linked" : "belongs_to_other";
  await linkIdentity(db, { provider: p.provider, subject: p.subject, label: p.label, person: handle, linkedBy: handle });
  return "linked";
}
```

- [ ] **Step 5: Run the two unit tests**

Run: `npx vitest run test/auth-invites.test.ts test/auth-fork.test.ts`
Expected: PASS.

- [ ] **Step 6: Failing onboard-route test**

`test/auth-onboard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { first } from "../src/db";
import { sealOnboard, ONBOARD_COOKIE, type OnboardPayload } from "../src/auth/onboard";
import { createInvite } from "../src/auth/invites";
import type { PersonRow, IdentityRow, InviteRow } from "@shared/rows";

const PAYLOAD: OnboardPayload = { provider: "google", subject: "g-123", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-n", invite_email: "priya.n@gmail.com" };
const cookie = async (p = PAYLOAD) => `${ONBOARD_COOKIE}=${await sealOnboard(p, "test-cookie-secret")}`;
const post = (path: string, c: string, body: unknown) => app.request(path, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) }, env);

describe("GET /auth/onboard", () => {
  it("returns the prefill without the subject; 401 without/with a bad cookie", async () => {
    const res = await app.request("/auth/onboard", { headers: { cookie: await cookie() } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ provider: "google", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-n" });
    expect((await app.request("/auth/onboard", {}, env)).status).toBe(401);
    expect((await app.request("/auth/onboard", { headers: { cookie: `${ONBOARD_COOKIE}=nope` } }, env)).status).toBe(401);
  });
});

describe("GET /auth/handle-check", () => {
  it("reports available / taken / invalid / reserved", async () => {
    const c = await cookie();
    const q = async (h: string) => (await (await app.request(`/auth/handle-check?handle=${h}`, { headers: { cookie: c } }, env)).json()) as { available: boolean; reason?: string };
    expect(await q("priya-n")).toEqual({ available: true });
    expect(await q("andresl230")).toEqual({ available: false, reason: "taken" });
    expect(await q("Bad")).toEqual({ available: false, reason: "invalid" });
    expect(await q("admin")).toEqual({ available: false, reason: "reserved" });
  });
});

describe("POST /auth/onboard", () => {
  it("creates person + identity, accepts the invite, sets a session, clears the cookie", async () => {
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: "Priya", invitedBy: "AndresL230" });
    const res = await post("/auth/onboard", await cookie(), { handle: "priya", name: "Priya N", color: "plum" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handle: "priya" });
    const setCookies = res.headers.get("set-cookie") ?? "";
    expect(setCookies).toContain("session=");
    expect(setCookies).toMatch(/onboard=;|onboard=; Max-Age=0|onboard=.*Max-Age=0/);
    const p = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'priya'`))!;
    expect(p.name).toBe("Priya N"); expect(p.color).toBe("plum"); expect(p.email).toBe("priya.n@gmail.com");
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'g-123'`))?.person).toBe("priya");
    expect((await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'priya.n@gmail.com'`))?.accepted_by).toBe("priya");
  });
  it("400 on an invalid handle/color; 409 on a taken handle (cookie kept)", async () => {
    const c = await cookie();
    expect((await post("/auth/onboard", c, { handle: "Bad", name: "x", color: "plum" })).status).toBe(400);
    expect((await post("/auth/onboard", c, { handle: "okay", name: "x", color: "neon" })).status).toBe(400);
    const taken = await post("/auth/onboard", c, { handle: "andresl230", name: "x", color: "plum" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "handle_taken" });
    expect(taken.headers.get("set-cookie") ?? "").not.toContain("onboard=;");
  });
  it("refuses when the invite was revoked after the cookie was issued", async () => {
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    await env.DB.prepare(`UPDATE invites SET revoked_at = 't' WHERE email = 'priya.n@gmail.com'`).run();
    const res = await post("/auth/onboard", await cookie(), { handle: "priya", name: "x", color: "plum" });
    expect(res.status).toBe(403);
    expect(await first(env.DB, `SELECT 1 AS x FROM persons WHERE handle = 'priya'`)).toBeNull();
  });
  it("a GitHub payload (invite_email null) onboards without any invite", async () => {
    const res = await post("/auth/onboard", await cookie({ ...PAYLOAD, provider: "github", subject: "newdev", label: "newdev", invite_email: null }), { handle: "newdev", name: "New", color: "sky" });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 7: Restructure `src/auth/routes.ts` as `buildAuthApp`**

Replace the file with the version below. The GitHub login route is unchanged except for the tx format and `deps.fetchImpl`; the callback now runs the fork.

```ts
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { PERSON_COLORS } from "@shared/rows";
import type { AppEnv } from "./principal";
import { isAdmin, resolveSessionPrincipal } from "./principal";
import { pkce, randomToken, hmacSeal, hmacUnseal } from "./crypto";
import { buildAuthorizeUrl, exchangeCode, getUser, getPrimaryEmail, isActiveOrgMember, SAPLING_ORG } from "./github";
import { createSession, setSessionCookie, readSessionCookie, deleteSession, clearSessionCookie } from "./session";
import { mintToken } from "./tokens";
import { getPerson, listIdentities, handleAvailable, createPerson, HandleTakenError, linkIdentity, unlinkIdentity, updateProfile } from "./persons";
import { completeSignIn, linkSignIn, sealOnboard, openOnboard, ONBOARD_COOKIE, ONBOARD_TTL_S, type ProviderProfile, type ForkResult } from "./onboard";
import { findLiveInvite, acceptInvite } from "./invites";

const OAUTH_TX_COOKIE = "oauth_tx";
export interface AuthDeps { fetchImpl?: typeof fetch; now?: () => number }

export function callbackUrl(reqUrl: string, provider: "github" | "google" = "github"): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const scheme = isLocal ? u.protocol.replace(/:$/, "") : "https";
  return `${scheme}://${u.host}${provider === "google" ? "/auth/google/callback" : "/auth/callback"}`;
}

type TxMode = "signin" | "link";
async function beginTx(c: Parameters<Parameters<Hono<AppEnv>["get"]>[1]>[0], mode: TxMode): Promise<{ state: string; challenge: string }> {
  const state = randomToken(16);
  const { verifier, challenge } = await pkce();
  const sealed = await hmacSeal(`${state}.${verifier}.${mode}`, c.env.COOKIE_SECRET);
  setCookie(c, OAUTH_TX_COOKIE, sealed, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  return { state, challenge };
}

export function buildAuthApp(deps: AuthDeps = {}): Hono<AppEnv> {
  const authApp = new Hono<AppEnv>();
  const f = deps.fetchImpl;

  /** Common tail after a provider profile is in hand. */
  async function finish(c: Parameters<Parameters<Hono<AppEnv>["get"]>[1]>[0], mode: TxMode, profile: ProviderProfile, denied: string) {
    if (mode === "link") {
      const me = await resolveSessionPrincipal(c);
      if (!me) return c.json({ error: "unauthorized" }, 403);
      const r = await linkSignIn(c.env.DB, me.handle, profile);
      return c.redirect(r === "linked" ? "/#settings" : "/?link=conflict#settings", 302);
    }
    const r: ForkResult = await completeSignIn(c.env.DB, profile);
    if (r.kind === "denied") return c.redirect(denied, 302);
    if (r.kind === "onboard") {
      setCookie(c, ONBOARD_COOKIE, await sealOnboard(r.payload, c.env.COOKIE_SECRET), { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: ONBOARD_TTL_S });
      return c.redirect("/#onboard", 302);
    }
    const { id } = await createSession(c.env.DB, r.handle);
    await setSessionCookie(c, id, c.env.COOKIE_SECRET);
    return c.redirect("/", 302);
  }

  async function openTx(c: Parameters<Parameters<Hono<AppEnv>["get"]>[1]>[0]) {
    const code = c.req.query("code"); const state = c.req.query("state");
    const sealedTx = getCookie(c, OAUTH_TX_COOKIE);
    deleteCookie(c, OAUTH_TX_COOKIE, { path: "/" });
    if (!code || !state || !sealedTx) return { error: c.json({ error: "invalid_request" }, 400) };
    const tx = await hmacUnseal(sealedTx, c.env.COOKIE_SECRET);
    if (!tx) return { error: c.json({ error: "bad_state" }, 403) };
    const [txState, verifier, mode] = tx.split(".");
    if (txState !== state) return { error: c.json({ error: "state_mismatch" }, 403) };
    return { code, verifier, mode: (mode === "link" ? "link" : "signin") as TxMode };
  }

  // ── GitHub ──
  authApp.get("/login", async (c) => {
    const mode: TxMode = c.req.query("link") === "1" && (await resolveSessionPrincipal(c)) ? "link" : "signin";
    const { state, challenge } = await beginTx(c, mode);
    return c.redirect(buildAuthorizeUrl({ clientId: c.env.GITHUB_CLIENT_ID, redirectUri: callbackUrl(c.req.url), state, challenge }), 302);
  });
  authApp.get("/callback", async (c) => {
    const tx = await openTx(c);
    if ("error" in tx) return tx.error;
    const token = await exchangeCode({ env: c.env, code: tx.code, redirectUri: callbackUrl(c.req.url), verifier: tx.verifier, fetchImpl: f });
    if (!token) return c.json({ error: "exchange_failed" }, 401);
    const gh = await getUser(token, f);
    if (!gh) return c.json({ error: "identity_failed" }, 401);
    if (!(await isActiveOrgMember(token, f))) return c.redirect("/?denied=1", 302);
    const profile: ProviderProfile = { provider: "github", subject: gh.login, label: gh.login, email: await getPrimaryEmail(token, f), name: gh.name, avatar_url: gh.avatar_url };
    return finish(c, tx.mode, profile, "/?denied=1");
  });

  // ── Google (Task 7 fills these two in) ──

  // ── Onboarding (gated by the onboard cookie, not the session) ──
  async function onboardPayload(c: Parameters<Parameters<Hono<AppEnv>["get"]>[1]>[0]) {
    const sealed = getCookie(c, ONBOARD_COOKIE);
    return sealed ? openOnboard(sealed, c.env.COOKIE_SECRET) : null;
  }
  authApp.get("/onboard", async (c) => {
    const p = await onboardPayload(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    return c.json({ provider: p.provider, label: p.label, email: p.email, name: p.name, avatar_url: p.avatar_url, suggested_handle: p.suggested_handle });
  });
  authApp.get("/handle-check", async (c) => {
    if (!(await onboardPayload(c))) return c.json({ error: "unauthorized" }, 401);
    return c.json(await handleAvailable(c.env.DB, (c.req.query("handle") ?? "").trim()));
  });
  const OnboardWrite = z.object({ handle: z.string().trim(), name: z.string().trim().max(120).nullable().optional(), color: z.enum(PERSON_COLORS) });
  authApp.post("/onboard", async (c) => {
    const p = await onboardPayload(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    const parsed = OnboardWrite.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    const avail = await handleAvailable(c.env.DB, parsed.data.handle);
    if (!avail.available) return c.json({ error: avail.reason === "taken" ? "handle_taken" : `handle_${avail.reason}` }, avail.reason === "taken" ? 409 : 400);
    if (p.invite_email && !(await findLiveInvite(c.env.DB, p.invite_email))) return c.json({ error: "invite_revoked" }, 403);
    try {
      await createPerson(c.env.DB, { handle: parsed.data.handle, name: parsed.data.name ?? p.name, color: parsed.data.color, avatar_url: p.avatar_url, email: p.email });
    } catch (e) {
      if (e instanceof HandleTakenError) return c.json({ error: "handle_taken" }, 409);
      throw e;
    }
    await linkIdentity(c.env.DB, { provider: p.provider, subject: p.subject, label: p.label, person: parsed.data.handle, linkedBy: parsed.data.handle });
    if (p.invite_email) await acceptInvite(c.env.DB, p.invite_email, parsed.data.handle);
    deleteCookie(c, ONBOARD_COOKIE, { path: "/" });
    const { id } = await createSession(c.env.DB, parsed.data.handle);
    await setSessionCookie(c, id, c.env.COOKIE_SECRET);
    return c.json({ ok: true, handle: parsed.data.handle });
  });

  // ── Session-gated ──
  authApp.get("/me", async (c) => {
    const handle = c.get("principal").handle;
    const row = await getPerson(c.env.DB, handle);
    const identities = (await listIdentities(c.env.DB, handle)).map((i) => ({ provider: i.provider, label: i.label, linked_at: i.linked_at }));
    return c.json({ handle, name: row?.name ?? null, avatar_url: row?.avatar_url ?? null, color: row?.color ?? "stone", identities, org: SAPLING_ORG, admin: isAdmin(c.env, handle) });
  });
  const ProfileWrite = z.object({ name: z.string().trim().max(120).nullable().optional(), color: z.enum(PERSON_COLORS).optional() });
  authApp.put("/me", async (c) => {
    const parsed = ProfileWrite.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    const row = await updateProfile(c.env.DB, c.get("principal").handle, parsed.data);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, name: row.name, color: row.color });
  });
  authApp.post("/identities/:provider/unlink", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "google") return c.json({ error: "unknown provider" }, 400);
    const r = await unlinkIdentity(c.env.DB, c.get("principal").handle, provider);
    if (r === "last_identity") return c.json({ error: "last_identity" }, 409);
    if (r === "not_found") return c.json({ error: "not linked" }, 404);
    return c.json({ ok: true });
  });
  authApp.post("/logout", async (c) => {
    const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
    if (id) await deleteSession(c.env.DB, id);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
  authApp.post("/mcp-token", async (c) => {
    const { raw } = await mintToken(c.env.DB, c.get("principal").handle);
    return c.json({ token: raw });
  });
  return authApp;
}

export const authApp = buildAuthApp();
```

`src/auth/github.ts` must `export { SAPLING_ORG }` already (it does). `test/auth-callback-url.test.ts` keeps passing (default provider = github).

- [ ] **Step 8: Run**

Run: `npx vitest run test/auth-onboard.test.ts test/auth-routes.test.ts test/auth-me.test.ts test/auth-callback-url.test.ts test/auth-gate.test.ts`
Expected: PASS. (`auth-me` now also gets `identities: [{provider:"github",…}]` in the body; assert it in that file.)

- [ ] **Step 9: Commit**

```bash
git add src/auth test/auth-*.test.ts
git commit -m "feat(auth): shared sign-in fork, onboarding cookie + routes, invites store, buildAuthApp"
```

---

### Task 7: Google login/callback routes, link mode, denied screen redirects

**Files:**
- Modify: `src/auth/routes.ts` (fill the Google section)
- Test: `test/auth-google-routes.test.ts`

**Interfaces:**
- Consumes: `buildGoogleAuthorizeUrl`, `exchangeGoogleCode`, `verifyGoogleIdToken` (Task 5); `finish`, `openTx`, `beginTx` (Task 6).
- Produces: `GET /auth/google/login[?login_hint=&prompt=&link=1]`, `GET /auth/google/callback`.

- [ ] **Step 1: Failing route test**

`test/auth-google-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { buildAuthApp } from "../src/auth/routes";
import { sessionGate, type AppEnv } from "../src/auth/principal";
import { hmacSeal } from "../src/auth/crypto";
import { first } from "../src/db";
import { createInvite } from "../src/auth/invites";
import { seedPerson, cookieFor } from "./helpers/persons";
import { makeGoogleKeys, signIdToken, googleFetch, CLAIMS } from "./helpers/google";
import type { IdentityRow } from "@shared/rows";

const NOW = () => 1_800_000_100_000;
function appWith(fetchImpl: typeof fetch) {
  const app = new Hono<AppEnv>();
  app.use("*", sessionGate);
  app.route("/auth", buildAuthApp({ fetchImpl, now: NOW }));
  return app;
}
const tx = async (mode = "signin") => `oauth_tx=${await hmacSeal(`st.ver.${mode}`, "test-cookie-secret")}`;

describe("GET /auth/google/login", () => {
  it("302s to Google with PKCE and a tx cookie; passes login_hint and prompt", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys).fetchImpl);
    const res = await app.request("/auth/google/login?login_hint=a%40b.c&prompt=select_account", {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(loc.searchParams.get("login_hint")).toBe("a@b.c");
    expect(loc.searchParams.get("prompt")).toBe("select_account");
    expect(loc.searchParams.get("redirect_uri")).toMatch(/\/auth\/google\/callback$/);
    expect(res.headers.get("set-cookie")).toContain("oauth_tx=");
  });
  it("?link=1 without a session falls back to a sign-in tx", async () => {
    const keys = await makeGoogleKeys();
    const res = await appWith(googleFetch(keys).fetchImpl).request("/auth/google/login?link=1", {}, env);
    expect(res.status).toBe(302);
  });
});

describe("GET /auth/google/callback", () => {
  it("invited + unknown → onboard cookie + redirect /#onboard", async () => {
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#onboard");
    expect(res.headers.get("set-cookie")).toContain("onboard=");
  });
  it("not invited → /?denied=invite&email=…", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.headers.get("location")).toBe("/?denied=invite&email=priya.n%40gmail.com");
  });
  it("unverified email → denied even when invited", async () => {
    await createInvite(env.DB, { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, { ...CLAIMS, email_verified: false }) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.headers.get("location")).toMatch(/^\/\?denied=invite/);
  });
  it("known identity → session cookie + redirect /", async () => {
    await seedPerson("priya");
    await env.DB.prepare(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'g-123', 'priya.n@gmail.com', 'priya', 't', 'priya')`).run();
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("session=");
  });
  it("bad ID token → 401 identity_failed", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: "garbage" }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.status).toBe(401);
  });
  it("link mode with a session attaches Google to the caller; conflict redirects with ?link=conflict", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const session = await cookieFor("AndresL230");
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: `${session}; ${await tx("link")}` } }, env);
    expect(res.headers.get("location")).toBe("/#settings");
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'g-123'`))?.person).toBe("AndresL230");
    const other = await cookieFor("Jose-Gael-Cruz-Lopez");
    const res2 = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: `${other}; ${await tx("link")}` } }, env);
    expect(res2.headers.get("location")).toBe("/?link=conflict#settings");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/auth-google-routes.test.ts`
Expected: FAIL (404 on the Google routes).

- [ ] **Step 3: Fill the Google section in `buildAuthApp`**

Add the imports `import { buildGoogleAuthorizeUrl, exchangeGoogleCode, verifyGoogleIdToken } from "./google";` and replace the `// ── Google (Task 7 fills these two in) ──` comment with:

```ts
  authApp.get("/google/login", async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: "google sign-in is not configured" }, 503);
    const mode: TxMode = c.req.query("link") === "1" && (await resolveSessionPrincipal(c)) ? "link" : "signin";
    const { state, challenge } = await beginTx(c, mode);
    return c.redirect(buildGoogleAuthorizeUrl({
      clientId: c.env.GOOGLE_CLIENT_ID, redirectUri: callbackUrl(c.req.url, "google"), state, challenge,
      loginHint: c.req.query("login_hint") || undefined, prompt: c.req.query("prompt") || undefined,
    }), 302);
  });
  authApp.get("/google/callback", async (c) => {
    const tx = await openTx(c);
    if ("error" in tx) return tx.error;
    const idToken = await exchangeGoogleCode({ env: c.env, code: tx.code, redirectUri: callbackUrl(c.req.url, "google"), verifier: tx.verifier, fetchImpl: f });
    if (!idToken) return c.json({ error: "exchange_failed" }, 401);
    const g = await verifyGoogleIdToken(idToken, { clientId: c.env.GOOGLE_CLIENT_ID ?? "", fetchImpl: f, now: deps.now });
    if (!g) return c.json({ error: "identity_failed" }, 401);
    const denied = `/?denied=invite&email=${encodeURIComponent(g.email)}`;
    if (!g.email_verified) return c.redirect(denied, 302);
    const profile: ProviderProfile = { provider: "google", subject: g.sub, label: g.email, email: g.email, name: g.name, avatar_url: g.picture };
    return finish(c, tx.mode, profile, denied);
  });
```

- [ ] **Step 4: Run**

Run: `npx vitest run test/auth-google-routes.test.ts test/auth-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Profile + unlink route test**

`test/auth-profile.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { first, run } from "../src/db";
import { cookieFor } from "./helpers/persons";
import type { PersonRow } from "@shared/rows";

const put = (path: string, cookie: string, body: unknown) => app.request(path, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const post = (path: string, cookie: string) => app.request(path, { method: "POST", headers: { cookie } }, env);

describe("PUT /auth/me", () => {
  it("updates name and color for the caller only; 400 on a bad color", async () => {
    const c = await cookieFor("AndresL230");
    const res = await put("/auth/me", c, { name: "Andrés", color: "rose" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Andrés", color: "rose" });
    const row = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`))!;
    expect(row.name).toBe("Andrés"); expect(row.color).toBe("rose");
    expect((await put("/auth/me", c, { color: "neon" })).status).toBe(400);
    expect((await put("/auth/me", "", { color: "moss" })).status).toBe(401);
  });
  it("GET /auth/me reflects color and identities", async () => {
    const c = await cookieFor("AndresL230");
    await run(env.DB, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'g-1', 'a@b.c', 'AndresL230', 't', 'AndresL230')`);
    const me = await (await app.request("/auth/me", { headers: { cookie: c } }, env)).json() as { handle: string; color: string; identities: { provider: string; label: string }[] };
    expect(me.handle).toBe("AndresL230");
    expect(me.color).toBe("moss");
    expect(me.identities.map((i) => i.provider).sort()).toEqual(["github", "google"]);
  });
});

describe("POST /auth/identities/:provider/unlink", () => {
  it("409 on the last identity, 200 when another remains, 404 when not linked, 400 on an unknown provider", async () => {
    const c = await cookieFor("AndresL230");
    expect((await post("/auth/identities/github/unlink", c)).status).toBe(409);
    await run(env.DB, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'g-1', 'a@b.c', 'AndresL230', 't', 'AndresL230')`);
    expect((await post("/auth/identities/google/unlink", c)).status).toBe(200);
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-1'`)).toBeNull();
    expect((await post("/auth/identities/google/unlink", c)).status).toBe(404);
    expect((await post("/auth/identities/twitter/unlink", c)).status).toBe(400);
  });
});
```

Run: `npx vitest run test/auth-profile.test.ts`
Expected: PASS (the routes exist since Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/auth/routes.ts test/auth-google-routes.test.ts test/auth-profile.test.ts
git commit -m "feat(auth): Google login/callback routes with link mode; profile + unlink route tests"
```

---

### Task 8: Invite email + admin invite routes

**Files:**
- Create: `src/notifications/invite.ts`
- Modify: `src/notifications/delivery.ts` (`unsubscribeUrl?`), `src/notifications/resend.ts` (headers only when present), `src/notifications/assemble.ts` (export `EMAIL_COLORS`, `EMAIL_FONT`), `src/routes.ts` (invite routes)
- Test: `test/invites.routes.test.ts`, `test/notifications.resend.test.ts` (one new case)

**Interfaces:**
- Produces `src/notifications/invite.ts`:
  ```ts
  export function inviteSignInUrl(origin: string, email: string): string; // `${origin}/auth/google/login?login_hint=${enc(email)}`
  export function renderInviteEmail(o: { inviteeName: string | null; inviterName: string; email: string; signInUrl: string; host: string }): { subject: string; html: string; text: string };
  export async function sendInvite(env: Env, db: DB, o: { email: string; inviteeName: string | null; inviterHandle: string; origin: string; fetchImpl?: typeof fetch }): Promise<{ status: "sent" | "failed"; id: string | null; error: string | null }>;
  ```
- Produces routes in `src/routes.ts` (admin-only): `GET /invites` → `{ invites: InviteRow[] }`; `POST /invites {email, name?}` → `{ ok, invite: InviteRow, email: {status,id,error} }`; `POST /invites/:email/revoke` → `{ ok }`; `POST /invites/:email/resend` → `{ ok, email: {…} }`.

- [ ] **Step 1: Sender changes (no behaviour change for digests)**

- `src/notifications/delivery.ts`: `unsubscribeUrl?: string;` on `OutboundMessage`.
- `src/notifications/resend.ts`: build `headers` only when `msg.unsubscribeUrl` is set:
  ```ts
  const headers = msg.unsubscribeUrl
    ? { "List-Unsubscribe": `<${mailto}>, <${msg.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  // …body: JSON.stringify({ from, to: [msg.to], subject, html, text, ...(headers ? { headers } : {}) })
  ```
- `src/notifications/assemble.ts`: add `export const EMAIL_COLORS = C;` after `C` and `export const EMAIL_FONT = { sans: SANS, mono: MONO } as const;` after `MONO`.

Add to `test/notifications.resend.test.ts`:

```ts
  it("omits the List-Unsubscribe headers when the message has no unsubscribeUrl (transactional mail)", async () => {
    const { calls, fetchImpl } = capture();
    const d = resendDelivery({ apiKey: "re_test", from: "Canopy <c@x>", fetchImpl });
    await d.send({ ...MSG, unsubscribeUrl: undefined });
    const body = JSON.parse(String(calls[0].init.body)) as { headers?: unknown };
    expect(body.headers).toBeUndefined();
  });
```

- [ ] **Step 2: Failing invite-route test**

`test/invites.routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first } from "../src/db";
import { cookieFor } from "./helpers/persons";
import { renderInviteEmail } from "../src/notifications/invite";
import type { InviteRow } from "@shared/rows";

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const bodies = () => all<{ idempotency_key: string; to_address: string; subject: string; html: string; text: string }>(env.DB, `SELECT * FROM notification_outbox_bodies ORDER BY created_at`);

describe("renderInviteEmail", () => {
  it("names the inviter, the address, and links the Google sign-in with login_hint", () => {
    const m = renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://canopy.test/auth/google/login?login_hint=priya.n%40gmail.com", host: "canopy.test" });
    expect(m.subject).toBe("Andres invited you to Canopy");
    expect(m.html).toContain("Hi Priya,");
    expect(m.html).toContain('href="https://canopy.test/auth/google/login?login_hint=priya.n%40gmail.com"');
    expect(m.html).toContain("priya.n@gmail.com");
    expect(m.text).toContain("https://canopy.test/auth/google/login?login_hint=priya.n%40gmail.com");
    expect(m.html).not.toContain("Unsubscribe");
  });
});

describe("/invites (admin, session-cookie)", () => {
  it("non-admin → 403; unauthenticated → 401", async () => {
    expect((await app.request("/invites", { headers: { cookie: await cookieFor("AndresL230") } }, env)).status).toBe(403);
    expect((await app.request("/invites", {}, env)).status).toBe(401);
  });
  it("POST creates the invite and sends the email through local delivery; GET lists it", async () => {
    const admin = await cookieFor("admin-user", { name: "Admin" });
    const res = await post("/invites", admin, { email: "Priya.N@gmail.com", name: "Priya" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; invite: InviteRow; email: { status: string; id: string | null; error: string | null } };
    expect(body.invite.email).toBe("priya.n@gmail.com");
    expect(body.email.status).toBe("sent");
    const rows = await bodies();
    expect(rows).toHaveLength(1);
    expect(rows[0].to_address).toBe("priya.n@gmail.com");
    expect(rows[0].subject).toBe("Admin invited you to Canopy");
    expect(rows[0].idempotency_key).toMatch(/^invite:priya\.n@gmail\.com:/);
    const inv = (await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'priya.n@gmail.com'`))!;
    expect(inv.email_sent_at).toBeTruthy(); expect(inv.email_error).toBeNull();
    const list = await (await app.request("/invites", { headers: { cookie: admin } }, env)).json() as { invites: InviteRow[] };
    expect(list.invites.map((i) => i.email)).toEqual(["priya.n@gmail.com"]);
  });
  it("POST 400 on a bad email, 409 on a duplicate live invite or an existing person's address", async () => {
    const admin = await cookieFor("admin-user");
    expect((await post("/invites", admin, { email: "nope" })).status).toBe(400);
    await post("/invites", admin, { email: "m@x.io" });
    expect((await post("/invites", admin, { email: "m@x.io" })).status).toBe(409);
    await cookieFor("priya", { email: "priya@x.io" });
    expect((await post("/invites", admin, { email: "priya@x.io" })).status).toBe(409);
  });
  it("resend writes a second body and updates email_sent_at; revoke is soft", async () => {
    const admin = await cookieFor("admin-user");
    await post("/invites", admin, { email: "m@x.io" });
    const before = (await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await post("/invites/m%40x.io/resend", admin)).status).toBe(200);
    expect((await bodies())).toHaveLength(2);
    const after = (await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!;
    expect(after.email_sent_at! > before.email_sent_at!).toBe(true);
    expect((await post("/invites/m%40x.io/revoke", admin)).status).toBe(200);
    expect((await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!.revoked_at).toBeTruthy();
    expect((await post("/invites/none%40x.io/revoke", admin)).status).toBe(404);
    expect((await post("/invites/m%40x.io/resend", admin)).status).toBe(409); // revoked → cannot resend
  });
  it("a delivery config error still creates the invite and records the error", async () => {
    const admin = await cookieFor("admin-user");
    const res = await app.request("/invites", { method: "POST", headers: { cookie: admin, "content-type": "application/json" }, body: JSON.stringify({ email: "m@x.io" }) }, { ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "" });
    expect(res.status).toBe(200);
    const body = await res.json() as { email: { status: string; error: string | null } };
    expect(body.email.status).toBe("failed");
    expect(body.email.error).toContain("RESEND_API_KEY");
    expect((await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!.email_error).toContain("RESEND_API_KEY");
  });
});
```

- [ ] **Step 3: Write `src/notifications/invite.ts`**

```ts
// The invite email: one transactional message per invite (create or resend),
// through the same delivery gate as the digests. Not a NotificationKind — no
// cadence, prefs, or window. The outcome lands on the invite row.
import type { Env } from "../env";
import { type DB, nowIso } from "../db";
import { escapeHtml } from "./html";
import { EMAIL_COLORS as C, EMAIL_FONT, FONTS_HREF, EMAIL_STYLE } from "./assemble";
import { deliveryFor } from "./resend";
import { loadSettings } from "./cron";
import { getPerson } from "../auth/persons";
import { recordInviteEmail } from "../auth/invites";

export function inviteSignInUrl(origin: string, email: string): string {
  return `${origin}/auth/google/login?login_hint=${encodeURIComponent(email)}`;
}

export function renderInviteEmail(o: { inviteeName: string | null; inviterName: string; email: string; signInUrl: string; host: string }): { subject: string; html: string; text: string } {
  const subject = `${o.inviterName} invited you to Canopy`;
  const hi = o.inviteeName ? `Hi ${escapeHtml(o.inviteeName)},` : "Hi,";
  const p = `${EMAIL_FONT.sans}font-size:14px;line-height:20px;color:${C.fg70};padding:0 0 12px 0;`;
  const button = `display:inline-block;${EMAIL_FONT.sans}font-size:14px;line-height:20px;font-weight:600;color:#ffffff;background-color:${C.accent};text-decoration:none;padding:10px 18px;border-radius:9px;`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title><link href="${FONTS_HREF}" rel="stylesheet"></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" style="padding:36px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:${C.bg};border:1px solid ${C.border};border-radius:13px;">` +
    `<tr><td style="padding:28px 28px 8px 28px;${EMAIL_FONT.sans}font-size:15px;font-weight:600;color:${C.fg};">Canopy</td></tr>` +
    `<tr><td style="padding:8px 28px 0 28px;"><div style="${p}color:${C.fg};">${hi}</div>` +
    `<div style="${p}">${escapeHtml(o.inviterName)} invited you to Canopy, the Sapling team's shared workspace. Sign in with this Google address to pick your handle and get started.</div>` +
    `<div style="padding:6px 0 20px 0;"><a href="${escapeHtml(o.signInUrl)}" style="${button}">Sign in with Google</a></div>` +
    `<div style="${EMAIL_FONT.sans}font-size:12.5px;line-height:20px;color:${C.fg55};padding-bottom:24px;">This invite is for <span style="${EMAIL_FONT.mono}">${escapeHtml(o.email)}</span>. If you weren't expecting it, you can ignore this email.</div></td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};${EMAIL_FONT.sans}font-size:12px;line-height:20px;color:${C.fg40};">Sent by Canopy &middot; ${escapeHtml(o.host)}</td></tr>` +
    `</table></td></tr></table></body></html>`;
  const text = [
    subject, "=".repeat(subject.length), "",
    o.inviteeName ? `Hi ${o.inviteeName},` : "Hi,", "",
    `${o.inviterName} invited you to Canopy, the Sapling team's shared workspace.`,
    "Sign in with this Google address to pick your handle and get started:", "",
    `  ${o.signInUrl}`, "",
    `This invite is for ${o.email}. If you weren't expecting it, you can ignore this email.`,
    `Sent by Canopy — ${o.host}`, "",
  ].join("\n");
  return { subject, html, text };
}

export async function sendInvite(env: Env, db: DB, o: { email: string; inviteeName: string | null; inviterHandle: string; origin: string; fetchImpl?: typeof fetch }): Promise<{ status: "sent" | "failed"; id: string | null; error: string | null }> {
  const inviter = await getPerson(db, o.inviterHandle);
  const settings = await loadSettings(db);
  const msg = renderInviteEmail({
    inviteeName: o.inviteeName, inviterName: inviter?.name ?? o.inviterHandle, email: o.email,
    signInUrl: inviteSignInUrl(o.origin, o.email), host: o.origin.replace(/^https?:\/\//, "") || "canopy",
  });
  let result: { status: "sent" | "failed"; id: string | null; error: string | null };
  try {
    const delivery = deliveryFor(env, { from: settings.from_address, fetchImpl: o.fetchImpl });
    const r = await delivery.send({ idempotencyKey: `invite:${o.email}:${nowIso()}`, userId: o.email, to: o.email, subject: msg.subject, html: msg.html, text: msg.text });
    result = { status: "sent", id: r.id, error: null };
  } catch (e) {
    result = { status: "failed", id: null, error: e instanceof Error ? e.message : String(e) };
  }
  await recordInviteEmail(db, o.email, { id: result.id, error: result.error });
  return result;
}
```

- [ ] **Step 4: Routes in `src/routes.ts`**

Add imports `import { z } from "zod";`, `import { createInvite, revokeInvite, listInvites } from "./auth/invites";`, `import { sendInvite } from "./notifications/invite";`, `import type { InviteRow } from "@shared/rows";`, `import { first } from "./db";` and, after the identity routes:

```ts
// ── Maintenance › People: the invite list (admin, session-cookie only, NEVER MCP) ──
const InviteWrite = z.object({ email: z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid email"), name: z.string().trim().max(120).optional() });
const adminGate = async (c: Parameters<Parameters<typeof app.get>[1]>[0], next: () => Promise<void>) =>
  isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403);
app.use("/invites", adminGate);
app.use("/invites/*", adminGate);
app.get("/invites", async (c) => c.json({ invites: await listInvites(c.env.DB) }));
app.post("/invites", async (c) => {
  const parsed = InviteWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  let invite: InviteRow;
  try {
    invite = await createInvite(c.env.DB, { email: parsed.data.email, name: parsed.data.name ?? null, invitedBy: c.get("principal").handle });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "invite_exists" || msg === "already_a_person") return c.json({ error: msg }, 409);
    throw e;
  }
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const email = await sendInvite(c.env, c.env.DB, { email: invite.email, inviteeName: invite.name, inviterHandle: c.get("principal").handle, origin });
  return c.json({ ok: true, invite: (await first<InviteRow>(c.env.DB, `SELECT * FROM invites WHERE email = ?`, invite.email))!, email });
});
app.post("/invites/:email/revoke", async (c) => {
  const ok = await revokeInvite(c.env.DB, decodeURIComponent(c.req.param("email")));
  return ok ? c.json({ ok: true }) : c.json({ error: "no such invite" }, 404);
});
app.post("/invites/:email/resend", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const row = await first<InviteRow>(c.env.DB, `SELECT * FROM invites WHERE email = ?`, email);
  if (!row) return c.json({ error: "no such invite" }, 404);
  if (row.revoked_at || row.accepted_by) return c.json({ error: row.revoked_at ? "revoked" : "accepted" }, 409);
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const result = await sendInvite(c.env, c.env.DB, { email: row.email, inviteeName: row.name, inviterHandle: c.get("principal").handle, origin });
  return c.json({ ok: true, email: result });
});
```

`first` may already be imported in `src/routes.ts`; if so, don't duplicate.

- [ ] **Step 5: Run**

Run: `npx vitest run test/invites.routes.test.ts test/notifications.resend.test.ts test/notifications.run.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/notifications src/routes.ts test/invites.routes.test.ts test/notifications.resend.test.ts
git commit -m "feat(invites): invite email via the delivery gate + admin invite routes"
```

---

### Task 9: Persons directory, identity mapping by handle, full suite

**Files:**
- Modify: `src/routes.ts` (`GET /persons`; `/identity-tasks/:login/map` body is `{ person: <handle> }`)
- Modify: `src/tools/reads.ts` (no change needed unless it imports the old `PersonRow` — check with `grep -n PersonRow src/tools/reads.ts`)
- Test: `test/persons.route.test.ts`, `test/identity-routes.test.ts`

**Interfaces:**
- Produces: `GET /persons` → `{ persons: { handle, name, color, avatar_url }[] }` (session-gated, every signed-in person).
- Consumes: `listPersons` (Task 2), `map_identity` (Task 3).

- [ ] **Step 1: Failing test**

`test/persons.route.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";

describe("GET /persons", () => {
  it("lists every person with handle, name, color, avatar_url — no email", async () => {
    const res = await app.request("/persons", { headers: { cookie: await cookieFor("AndresL230") } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { persons: Record<string, unknown>[] };
    expect(body.persons.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(body.persons[0]).sort()).toEqual(["avatar_url", "color", "handle", "name"]);
  });
  it("401 without a session", async () => {
    expect((await app.request("/persons", {}, env)).status).toBe(401);
  });
});
```

Add to `test/identity-routes.test.ts` a case that maps to a seeded handle and asserts the identities row, and one that returns 400 for an unknown person:

```ts
  it("map to an existing handle links the login; unknown person → 400", async () => {
    const cookie = await cookieFor("AndresL230"); // from ./helpers/persons (the local authedCookie was removed in Task 4)
    await seedPerson("casey");
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "t", "2026-07-01T00:00:00Z"), "github-webhook");
    const ok = await post("/identity-tasks/mystery-dev/map", cookie, { person: "casey" });
    expect(ok.status).toBe(200);
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'mystery-dev'`))?.person).toBe("casey");
    await ingestEvent(env.DB, prEvent(2, "other-dev", "t", "2026-07-01T00:00:00Z"), "github-webhook");
    expect((await post("/identity-tasks/other-dev/map", cookie, { person: "ghost" })).status).toBe(400);
  });
```

- [ ] **Step 2: Route**

In `src/routes.ts`, after `/identity-tasks/:login/map`, add `import { listPersons } from "./auth/persons";` and:

```ts
// Person directory (session-gated): the avatar-chip source for every screen and the identity picker.
app.get("/persons", async (c) => c.json({ persons: await listPersons(c.env.DB) }));
```

- [ ] **Step 3: Full run + typecheck**

Run: `npx vitest run test/persons.route.test.ts test/identity-routes.test.ts && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/routes.ts test/persons.route.test.ts test/identity-routes.test.ts
git commit -m "feat(identity): persons directory route; identity map targets a handle"
```

---

### Task 10: Web — API client, state, sign-in card, not-invited card, onboarding screen

**Files:**
- Modify: `web/src/api.ts` (`Me` shape; onboarding + profile + invites + persons calls), `web/src/render.ts` (`AppState`, `authView`, `loginCard`, `notInvitedCard`, `onboardView`), `web/src/main.ts` (boot, dispatch cases, debounced handle check), `web/src/canopy.css` (person color tokens), `web/src/ui.ts` (`personChip`)
- Create: `web/src/people.ts` (pure onboarding + chip render helpers so they are testable)
- Test: `test/render.onboard.test.ts` (pure; add to BOTH `tsconfig.worker.json` `exclude` and `tsconfig.web.json` `include`)

**Interfaces:**
- `web/src/api.ts`:
  ```ts
  export interface MeIdentity { provider: "github" | "google"; label: string; linked_at: string }
  export interface Me { handle: string; name: string | null; avatar_url: string | null; color: PersonColor; identities: MeIdentity[]; org: string; admin: boolean }
  export interface OnboardPrefill { provider: "github" | "google"; label: string; email: string | null; name: string | null; avatar_url: string | null; suggested_handle: string }
  export function getOnboardPrefill(): Promise<OnboardPrefill>;                          // GET /auth/onboard (401 → Unauthorized)
  export function checkHandle(handle: string): Promise<{ available: boolean; reason?: "invalid" | "reserved" | "taken" }>;
  export function submitOnboard(b: { handle: string; name: string | null; color: PersonColor }): Promise<{ ok: true; handle: string }>;
  export function updateMe(b: { name?: string | null; color?: PersonColor }): Promise<{ ok: true; name: string | null; color: PersonColor }>;
  export function unlinkIdentity(provider: "github" | "google"): Promise<{ ok: true }>;
  export interface PersonSummary { handle: string; name: string | null; color: PersonColor; avatar_url: string | null }
  export function listPersons(): Promise<PersonSummary[]>;
  export function listInvites(): Promise<InviteRow[]>;
  export function createInvite(email: string, name?: string): Promise<{ ok: true; invite: InviteRow; email: { status: "sent" | "failed"; error: string | null } }>;
  export function revokeInvite(email: string): Promise<{ ok: true }>;
  export function resendInvite(email: string): Promise<{ ok: true; email: { status: "sent" | "failed"; error: string | null } }>;
  ```
- `web/src/people.ts`:
  ```ts
  export const COLOR_NAMES: readonly PersonColor[];  // = PERSON_COLORS
  export interface OnboardState { prefill: OnboardPrefill | null; handle: string; name: string; color: PersonColor; check: "idle" | "checking" | "available" | "invalid" | "reserved" | "taken"; submitting: boolean; error: string | null }
  export function initialOnboard(): OnboardState;
  export function onboardView(o: OnboardState): string;                               // pure HTML
  export function feedPreviewRow(p: { name: string; handle: string; color: PersonColor }): string;
  export function swatches(act: string, selected: PersonColor, compact?: boolean): string;
  export function personChip(p: { handle: string; name?: string | null; color: PersonColor; avatar_url?: string | null } | null, size: number, fallback: string): string; // initials on the color, provider image on top
  ```
- `AppState` gains: `authStep: "login" | "verifying" | "nonmember" | "notinvited" | "onboard"`, `deniedEmail: string | null`, `onboard: OnboardState`, `persons: Loadable<PersonSummary[]>`, `invites: Loadable<InviteRow[]>`, `inviteDraft: string`.

- [ ] **Step 1: Color tokens**

Append to `web/src/canopy.css` (in the utility layer, after the theme blocks):

```css
/* ── person colors (0023): stored by name; one set per theme, midnight reuses dark ── */
[data-cnpy-theme="light"] { --p-moss:#6f8a3a; --p-fern:#2f7d57; --p-sky:#3e6f8a; --p-slate:#5b6b8c; --p-plum:#7a4f8f; --p-rose:#a84a68; --p-rust:#b4562c; --p-ochre:#a8791e; --p-clay:#8c5a3c; --p-stone:#6b665e; }
[data-cnpy-theme="dark"], [data-cnpy-theme="midnight"] { --p-moss:#9aab65; --p-fern:#5ab88a; --p-sky:#6aa8c4; --p-slate:#8d9bc0; --p-plum:#b48ac8; --p-rose:#d47a97; --p-rust:#d98a52; --p-ochre:#d4a84a; --p-clay:#c2895f; --p-stone:#9a958d; }
.cnpy-sw { display:flex; flex-direction:column; align-items:center; gap:6px; padding:10px 6px 8px; border-radius:10px; border:1px solid transparent; transition:border-color .12s ease, background .12s ease; }
.cnpy-sw:hover { background:var(--hover); }
.cnpy-sw i { width:28px; height:28px; border-radius:50%; background:var(--c); display:block; box-shadow:0 0 0 2px var(--bg), 0 0 0 3px transparent; }
.cnpy-sw span { font-family:var(--mono); font-size:10.5px; color:var(--fg-55); }
.cnpy-sw.is-on { border-color:var(--border-strong); background:var(--hover); }
.cnpy-sw.is-on i { box-shadow:0 0 0 2px var(--bg), 0 0 0 3px var(--c); }
.cnpy-sw.is-on span { color:var(--fg); }
.cnpy-sw.compact { padding:6px 2px; } .cnpy-sw.compact i { width:22px; height:22px; } .cnpy-sw.compact span { display:none; }
```

- [ ] **Step 2: Failing pure render test**

`test/render.onboard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initialOnboard, onboardView, swatches, personChip, feedPreviewRow } from "../web/src/people";

describe("onboardView", () => {
  it("renders handle input, ten swatches with the selected one marked, the preview, and a disabled submit until available", () => {
    const s = { ...initialOnboard(), prefill: { provider: "google" as const, label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-n" }, handle: "priya-n", name: "Priya Natarajan", color: "plum" as const, check: "idle" as const };
    const html = onboardView(s);
    expect(html).toContain('data-act="onbHandle"');
    expect(html).toContain('value="priya-n"');
    expect((html.match(/class="cnpy-sw/g) ?? []).length).toBe(10);
    expect(html).toContain('data-arg="plum" class="cnpy-sw is-on"');
    expect(html).toContain("@priya-n");
    expect(html).toContain('data-act="onbSubmit"');
    expect(html).toMatch(/data-act="onbSubmit"[^>]*disabled/);
    const ok = onboardView({ ...s, check: "available" });
    expect(ok).not.toMatch(/data-act="onbSubmit"[^>]*disabled/);
    expect(ok).toContain("available");
    expect(onboardView({ ...s, check: "taken" })).toContain("taken");
    expect(onboardView({ ...s, handle: "Bad", check: "invalid" })).toContain("invalid");
  });
  it("escapes user-controlled text", () => {
    const s = { ...initialOnboard(), name: "<img src=x>", handle: "x", color: "moss" as const };
    expect(onboardView(s)).not.toContain("<img src=x>");
  });
});

describe("swatches / personChip / feedPreviewRow", () => {
  it("swatches emit one button per color with the act and selected state", () => {
    const html = swatches("setColor", "sky");
    expect((html.match(/data-act="setColor"/g) ?? []).length).toBe(10);
    expect(html).toContain('data-arg="sky" class="cnpy-sw is-on"');
  });
  it("personChip renders initials on the color, or the avatar image when present, or a neutral fallback", () => {
    expect(personChip({ handle: "priya", name: "Priya Natarajan", color: "plum" }, 30, "?")).toContain("var(--p-plum)");
    expect(personChip({ handle: "priya", name: "Priya Natarajan", color: "plum" }, 30, "?")).toContain(">PN<");
    expect(personChip({ handle: "priya", color: "plum", avatar_url: "https://a/p.png" }, 30, "?")).toContain('src="https://a/p.png"');
    expect(personChip(null, 30, "mystery-dev")).toContain(">MY<");
    expect(personChip(null, 30, "mystery-dev")).not.toContain("var(--p-");
  });
  it("feedPreviewRow shows the handle in the chosen color", () => {
    expect(feedPreviewRow({ name: "Priya", handle: "priya", color: "rose" })).toContain("@priya");
    expect(feedPreviewRow({ name: "Priya", handle: "priya", color: "rose" })).toContain("var(--p-rose)");
  });
});
```

Add `"test/render.onboard.test.ts"` to the `exclude` list in `tsconfig.worker.json` and to the `include` list in `tsconfig.web.json`.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/render.onboard.test.ts`
Expected: FAIL — cannot resolve `../web/src/people`.

- [ ] **Step 4: Write `web/src/people.ts`**

```ts
// Person presentation: the avatar chip (initials on the person's color, provider
// image on top), the color swatch picker, and the onboarding screen. Pure
// functions over state — no fetch, no DOM — so they are unit-testable.
import { PERSON_COLORS, type PersonColor } from "@shared/rows";
import { esc, attr, initialsOf } from "./ui";
import type { OnboardPrefill } from "./api";

export const COLOR_NAMES: readonly PersonColor[] = PERSON_COLORS;

export interface OnboardState {
  prefill: OnboardPrefill | null;
  handle: string; name: string; color: PersonColor;
  check: "idle" | "checking" | "available" | "invalid" | "reserved" | "taken";
  submitting: boolean; error: string | null;
}
export function initialOnboard(): OnboardState {
  return { prefill: null, handle: "", name: "", color: "moss", check: "idle", submitting: false, error: null };
}

/** Initials from a display name ("Priya Natarajan" → "PN"), falling back to the login rule. */
export function initialsOfName(name: string | null | undefined, fallback: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
  return initialsOf(fallback);
}

export function personChip(p: { handle: string; name?: string | null; color: PersonColor; avatar_url?: string | null } | null, size: number, fallback: string): string {
  const font = Math.max(9, Math.round(size * 0.36));
  if (!p) {
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;border:1px solid var(--border-strong);background:color-mix(in srgb,var(--fg) 7%,transparent);display:grid;place-items:center;font-size:${font}px;font-weight:600;color:var(--fg);flex:none">${esc(initialsOf(fallback))}</div>`;
  }
  const inner = p.avatar_url
    ? `<img src="${attr(p.avatar_url)}" width="${size}" height="${size}" alt="" style="display:block;width:100%;height:100%;border-radius:50%;object-fit:cover" />`
    : esc(initialsOfName(p.name, p.handle));
  return `<div title="${attr(p.name ?? p.handle)}" style="--c:var(--p-${p.color});width:${size}px;height:${size}px;border-radius:50%;background:var(--c);box-shadow:0 0 0 1.5px color-mix(in srgb,var(--c) 45%,transparent);display:grid;place-items:center;font-size:${font}px;font-weight:600;color:#fff;flex:none;overflow:hidden">${inner}</div>`;
}

export function swatches(act: string, selected: PersonColor, compact = false): string {
  return `<div role="radiogroup" style="display:grid;grid-template-columns:repeat(${compact ? 10 : 5},1fr);gap:${compact ? 4 : 10}px">${COLOR_NAMES.map((c) =>
    `<button type="button" role="radio" aria-checked="${c === selected}" data-act="${attr(act)}" data-arg="${c}" class="cnpy-sw${c === selected ? " is-on" : ""}${compact ? " compact" : ""}" style="--c:var(--p-${c})"><i></i><span>${c}</span></button>`).join("")}</div>`;
}

export function feedPreviewRow(p: { name: string; handle: string; color: PersonColor }): string {
  return `<div style="display:flex;align-items:flex-start;gap:11px">
    ${personChip({ handle: p.handle, name: p.name, color: p.color }, 30, p.handle || "?")}
    <div><div style="font-size:12.5px;color:var(--fg-55)"><b style="color:var(--fg);font-weight:600">${esc(p.name || "Your name")}</b> · <span style="font-family:var(--mono);color:var(--p-${p.color});font-weight:500">@${esc(p.handle || "…")}</span> · 2 min ago</div>
    <div style="font-size:13.5px;margin-top:3px;color:var(--fg-70)">Drafted the fall enrollment email sequence; needs a review before Monday.</div></div>
  </div>`;
}

const STATUS: Record<OnboardState["check"], { text: string; color: string }> = {
  idle: { text: "", color: "var(--fg-40)" }, checking: { text: "checking…", color: "var(--fg-40)" },
  available: { text: "available", color: "var(--green)" }, invalid: { text: "invalid", color: "var(--red)" },
  reserved: { text: "reserved", color: "var(--red)" }, taken: { text: "taken", color: "var(--red)" },
};

export function onboardView(o: OnboardState): string {
  const st = STATUS[o.check];
  const canSubmit = o.check === "available" && !o.submitting;
  const signedAs = o.prefill ? `Signed in with ${o.prefill.provider === "google" ? "Google" : "GitHub"} as <span style="font-family:var(--mono);color:var(--fg-55)">${esc(o.prefill.label)}</span>` : "";
  const field = (label: string, inner: string, help = "") => `<div><label style="display:block;font-size:12.5px;font-weight:500;color:var(--fg-70);margin-bottom:7px">${label}</label>${inner}${help ? `<div style="font-size:12px;color:var(--fg-40);margin-top:7px;line-height:1.5">${help}</div>` : ""}</div>`;
  const row = "display:flex;align-items:center;border:1px solid var(--border-strong);border-radius:9px;background:var(--bg);overflow:hidden";
  const input = "flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--fg);font-size:14px;padding:11px 12px";
  return `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px"><div style="width:100%;max-width:520px">
    <div style="margin-bottom:26px">
      <div style="font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg-40);margin-bottom:10px">Welcome to Canopy · one step</div>
      <h1 style="font-size:22px;font-weight:600;letter-spacing:-0.02em;margin:0 0 6px">Choose how you'll appear.</h1>
      <p style="font-size:14px;color:var(--fg-70);margin:0;line-height:1.55">Your handle is how work gets attributed to you, in the feed, in decisions, in My Work. It can't be changed later. Your color can.</p>
    </div>
    <div style="display:grid;gap:22px">
      ${field("Handle", `<div style="${row}"><span style="font-family:var(--mono);font-size:14px;color:var(--fg-40);padding-left:12px">@</span><input data-act="onbHandle" data-field="onbHandle" value="${attr(o.handle)}" autocomplete="off" spellcheck="false" maxlength="24" class="cnpy-input" style="${input};padding-left:4px;font-family:var(--mono)" /><span style="font-family:var(--mono);font-size:11px;padding:0 12px;white-space:nowrap;color:${st.color}">${esc(st.text)}</span></div>`,
        "2 to 24 characters. Lowercase letters, numbers and hyphens. Starts with a letter.")}
      ${field("Display name", `<div style="${row}"><input data-act="onbName" data-field="onbName" value="${attr(o.name)}" maxlength="120" class="cnpy-input" style="${input}" /></div>`)}
      ${field("Your color", swatches("onbColor", o.color))}
      <div style="border:1px solid var(--border);border-radius:11px;padding:12px 14px;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
        <div style="font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--fg-40);margin-bottom:10px">How you'll appear in the feed</div>
        ${feedPreviewRow({ name: o.name, handle: o.handle, color: o.color })}
      </div>
      ${o.error ? `<div style="font-size:12.5px;color:var(--red)">${esc(o.error)}</div>` : ""}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--fg-40)">${signedAs}</div>
        <button data-act="onbSubmit" class="cnpy-accentbtn" ${canSubmit ? "" : "disabled "}style="padding:11px 20px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600;${canSubmit ? "" : "opacity:.45;cursor:default"}">${o.submitting ? "Entering…" : "Enter Canopy"}</button>
      </div>
    </div>
  </div></div>`;
}
```

- [ ] **Step 5: API client**

In `web/src/api.ts` replace the `Me` interface with the shape in Interfaces (import `PersonColor`, `InviteRow` from `@shared/rows`), and add:

```ts
export interface OnboardPrefill { provider: "github" | "google"; label: string; email: string | null; name: string | null; avatar_url: string | null; suggested_handle: string }
export function getOnboardPrefill(): Promise<OnboardPrefill> { return getJson<OnboardPrefill>("/auth/onboard"); }
export function checkHandle(handle: string): Promise<{ available: boolean; reason?: "invalid" | "reserved" | "taken" }> {
  return getJson(`/auth/handle-check?handle=${encodeURIComponent(handle)}`);
}
export function submitOnboard(b: { handle: string; name: string | null; color: PersonColor }): Promise<{ ok: true; handle: string }> { return postJson("/auth/onboard", b); }
export function updateMe(b: { name?: string | null; color?: PersonColor }): Promise<{ ok: true; name: string | null; color: PersonColor }> { return putJson("/auth/me", b); }
export function unlinkIdentity(provider: "github" | "google"): Promise<{ ok: true }> { return postJson(`/auth/identities/${provider}/unlink`); }
export interface PersonSummary { handle: string; name: string | null; color: PersonColor; avatar_url: string | null }
export function listPersons(): Promise<PersonSummary[]> { return getJson<{ persons: PersonSummary[] }>("/persons").then((r) => r.persons); }
export function listInvites(): Promise<InviteRow[]> { return getJson<{ invites: InviteRow[] }>("/invites").then((r) => r.invites); }
export function createInvite(email: string, name?: string): Promise<{ ok: true; invite: InviteRow; email: { status: "sent" | "failed"; error: string | null } }> { return postJson("/invites", { email, name }); }
export function revokeInvite(email: string): Promise<{ ok: true }> { return postJson(`/invites/${encodeURIComponent(email)}/revoke`); }
export function resendInvite(email: string): Promise<{ ok: true; email: { status: "sent" | "failed"; error: string | null } }> { return postJson(`/invites/${encodeURIComponent(email)}/resend`); }
```

`putJson` exists at line ~46 (the PUT helper used by notification prefs); if it is named differently, use that name. Add `InviteRow`, `PersonColor` to the `@shared/rows` import and re-export `InviteRow`.

- [ ] **Step 6: State + views in `web/src/render.ts`**

- `AppState`: `authStep: "login" | "verifying" | "nonmember" | "notinvited" | "onboard"`; add `deniedEmail: string | null; onboard: OnboardState; persons: Loadable<PersonSummary[]>; invites: Loadable<InviteRow[]>; inviteDraft: string;` and initialise them in `initialState()` (`deniedEmail: null, onboard: initialOnboard(), persons: { status: "idle", data: [] }, invites: { status: "idle", data: [] }, inviteDraft: ""`).
- Every `s.me.login` / `s.me?.login` → `.handle` (`grep -n "me?.login\|me.login" web/src/render.ts web/src/main.ts`).
- `authView`: add `${s.authStep === "notinvited" ? notInvitedCard(s.deniedEmail) : ""}` and `${s.authStep === "onboard" ? onboardView(s.onboard) : ""}` (import from `./people`).
- `loginCard()`: after the GitHub button insert:

```ts
      <div style="display:flex;align-items:center;gap:12px;font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg-40)"><span style="flex:1;height:1px;background:var(--border)"></span>or<span style="flex:1;height:1px;background:var(--border)"></span></div>
      <button data-act="signInGoogle" class="cnpy-outlinebtn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:14px;font-weight:600;color:var(--fg)">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.2v3.1C3.2 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.3c-.5-1.5-.5-3.1 0-4.6V6.6H1.2c-1.6 3.3-1.6 7.3 0 10.6l4.1-2.9z"/><path fill="#EA4335" d="M12 4.7c1.7 0 3.3.6 4.5 1.7l3.4-3.4C17.9 1.1 15.1 0 12 0 7.3 0 3.2 2.7 1.2 6.6l4.1 3.1c.9-2.9 3.6-5 6.7-5z"/></svg>
        Continue with Google
      </button>
```
  and change the footer line to `GitHub for engineers. Google for everyone else on the team, by invitation.`
- New `notInvitedCard(email: string | null)`: copy `nonmemberCard()` and change the title to `This Google account hasn't been invited yet.`, the body to `Canopy is limited to the Sapling team. Ask an admin to invite <span mono>${esc(email ?? "your address")}</span>, then sign in again.`, the chip to `Signed in with Google as / ${email}`, and the button to `<button data-act="signInGoogleSwitch" …>Try a different account</button>`.

- [ ] **Step 7: Dispatch + boot in `web/src/main.ts`**

Imports: `getOnboardPrefill, checkHandle, submitOnboard` from `./api`; `initialOnboard` from `./people`.

Dispatch cases (next to `signIn`):

```ts
    case "signInGoogle":
      try { if (location.hash) sessionStorage.setItem("canopy.returnHash", location.hash); } catch { /* ignore */ }
      window.location.href = "/auth/google/login";
      return;
    case "signInGoogleSwitch": window.location.href = "/auth/google/login?prompt=select_account"; return;
    case "onbHandle": {
      state.onboard.handle = (value ?? "").trim();
      state.onboard.check = state.onboard.handle ? "checking" : "idle";
      scheduleHandleCheck();
      rerender();
      return;
    }
    case "onbName": state.onboard.name = value ?? ""; rerender(); return;
    case "onbColor": if (arg) state.onboard.color = arg as PersonColor; break;
    case "onbSubmit": {
      const o = state.onboard;
      if (o.check !== "available" || o.submitting) return;
      o.submitting = true; o.error = null; rerender();
      submitOnboard({ handle: o.handle, name: o.name.trim() || null, color: o.color })
        .then(() => { window.location.href = "/"; })
        .catch((e) => {
          o.submitting = false;
          if (e instanceof ApiError && e.message === "handle_taken") { o.check = "taken"; }
          else if (e instanceof ApiError && e.message === "invite_revoked") { o.error = "This invite was revoked. Ask an admin to invite you again."; }
          else if (e instanceof Unauthorized) { o.error = "This sign-in expired. Start again."; }
          else { o.error = "Couldn't finish sign-up. Try again."; }
          rerender();
        });
      return;
    }
```

Debounced check (module scope):

```ts
let handleCheckTimer: number | null = null;
let handleCheckSeq = 0;
function scheduleHandleCheck(): void {
  if (handleCheckTimer !== null) clearTimeout(handleCheckTimer);
  const seq = ++handleCheckSeq;
  const h = state.onboard.handle;
  if (!h) return;
  handleCheckTimer = window.setTimeout(() => {
    checkHandle(h)
      .then((r) => { if (seq !== handleCheckSeq) return; state.onboard.check = r.available ? "available" : (r.reason ?? "invalid"); rerender(); })
      .catch(() => { if (seq !== handleCheckSeq) return; state.onboard.check = "idle"; rerender(); });
  }, 250);
}
```

Boot: replace the `denied === "1"` block with:

```ts
const params = new URLSearchParams(location.search);
if (params.get("denied") === "1") {
  state.view = "auth"; state.authStep = "nonmember"; rerender();
} else if (params.get("denied") === "invite") {
  state.view = "auth"; state.authStep = "notinvited"; state.deniedEmail = params.get("email"); rerender();
} else if (location.hash === "#onboard") {
  state.view = "auth"; state.authStep = "verifying"; rerender();
  getOnboardPrefill()
    .then((p) => {
      state.onboard = { ...initialOnboard(), prefill: p, handle: p.suggested_handle, name: p.name ?? "", check: "checking" };
      state.authStep = "onboard"; scheduleHandleCheck(); rerender();
    })
    .catch(() => { state.authStep = "login"; history.replaceState(null, "", "/"); rerender(); });
} else {
  // …existing verifying + getMe() flow unchanged…
}
```

In the existing `getMe().then` set `state.displayName = me.name ?? me.handle;`. The `#onboard` hash must never be treated as a screen: `SCREENS` does not include it, so `screenFromHash()` falls back to `mywork`; nothing else to do.

- [ ] **Step 8: Run render tests + typecheck + build**

Run: `npx vitest run test/render.onboard.test.ts test/render.mywork.test.ts test/render.review.test.ts test/render.roadmap.test.ts test/render.docs.test.ts test/render.notifications.test.ts && npm run typecheck && npm run build:web`
Expected: all green; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add web/src tsconfig.worker.json tsconfig.web.json test/render.onboard.test.ts
git commit -m "feat(web): Google sign-in button, not-invited card, onboarding screen, person color tokens"
```

---

### Task 11: Web — Settings › Profile, Maintenance › People, colored chips everywhere

**Files:**
- Modify: `web/src/render.ts` (`settingsView` Profile section; sidebar chip; feed author chip; `maintenanceScreen` splices People), `web/src/main.ts` (profile + invite dispatch, loaders), `web/src/maintenance.ts` (`peopleSection`, `Person` gains `color`), `web/src/triage-map.ts` (`peopleFromPersons` replaces `peopleFromLogins`)
- Test: `test/render.people.test.ts` (pure; add to both tsconfigs), `test/triage-map.test.ts` (one case)

**Interfaces:**
- `web/src/maintenance.ts`:
  ```ts
  export interface Person { id: string; name: string; initials: string; color?: PersonColor; avatar_url?: string | null }
  export interface PeopleProps { persons: PersonSummary[]; invites: InviteRow[]; inviteDraft: string; loading: boolean; error: string | null }
  export function peopleSection(p: PeopleProps): string;   // header + invite input + person rows + pending invite rows
  ```
- `web/src/triage-map.ts`: `export function peopleFromPersons(persons: PersonSummary[]): Person[]`.
- `web/src/render.ts`: `export function profileSection(s: AppState): string` (pure, for the test).

- [ ] **Step 1: Failing pure render test**

`test/render.people.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { peopleSection } from "../web/src/maintenance";
import { profileSection, initialState } from "../web/src/render";
import { peopleFromPersons } from "../web/src/triage-map";

const persons = [
  { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null },
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: "https://a/p.png" },
];
const invites = [
  { email: "m.okafor@gmail.com", name: null, invited_by: "AndresL230", invited_at: "2026-09-12T10:00:00Z", accepted_by: null, revoked_at: null, email_sent_at: "2026-09-12T10:00:01Z", email_id: null, email_error: null },
  { email: "done@x.io", name: "Done", invited_by: "AndresL230", invited_at: "2026-09-01T10:00:00Z", accepted_by: "done", revoked_at: null, email_sent_at: "t", email_id: null, email_error: null },
  { email: "bad@x.io", name: null, invited_by: "AndresL230", invited_at: "2026-09-11T10:00:00Z", accepted_by: null, revoked_at: null, email_sent_at: "t", email_id: null, email_error: "resend 500" },
];

describe("peopleSection", () => {
  it("lists persons with colored chips and pending invites with Resend/Revoke; accepted invites are not pending", () => {
    const html = peopleSection({ persons, invites, inviteDraft: "", loading: false, error: null });
    expect(html).toContain("PEOPLE");
    expect(html).toContain("@AndresL230");
    expect(html).toContain("var(--p-plum)");
    expect(html).toContain("m.okafor@gmail.com");
    expect(html).toContain('data-act="inviteResend" data-arg="m.okafor@gmail.com"');
    expect(html).toContain('data-act="inviteRevoke" data-arg="m.okafor@gmail.com"');
    expect(html).not.toContain('data-arg="done@x.io"');
    expect(html).toContain("resend 500");
    expect(html).toContain('data-act="inviteDraft"');
    expect(html).toContain('data-act="inviteSend"');
  });
  it("disables Invite until the draft looks like an email", () => {
    expect(peopleSection({ persons, invites: [], inviteDraft: "nope", loading: false, error: null })).toMatch(/data-act="inviteSend"[^>]*disabled/);
    expect(peopleSection({ persons, invites: [], inviteDraft: "a@b.co", loading: false, error: null })).not.toMatch(/data-act="inviteSend"[^>]*disabled/);
  });
});

describe("profileSection", () => {
  it("shows handle read-only, ten swatches with mine selected, and link/unlink per provider", () => {
    const s = initialState();
    s.me = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], org: "SaplingLearn", admin: false };
    s.displayName = "Andres";
    const html = profileSection(s);
    expect(html).toContain("@AndresL230");
    expect(html).toContain('data-arg="moss" class="cnpy-sw is-on compact"');
    expect(html).toContain('data-act="linkProvider" data-arg="google"');
    expect(html).toMatch(/data-act="unlinkProvider" data-arg="github"[^>]*disabled/); // last identity
    s.me.identities.push({ provider: "google", label: "a@b.c", linked_at: "t" });
    const both = profileSection(s);
    expect(both).not.toMatch(/data-act="unlinkProvider" data-arg="github"[^>]*disabled/);
    expect(both).toContain('data-act="unlinkProvider" data-arg="google"');
  });
});

describe("peopleFromPersons", () => {
  it("maps directory rows to picker entries keyed by handle", () => {
    expect(peopleFromPersons(persons)[1]).toEqual({ id: "priya", name: "Priya Natarajan", initials: "PN", color: "plum", avatar_url: "https://a/p.png" });
  });
});
```

Add `"test/render.people.test.ts"` to both tsconfig lists.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/render.people.test.ts`
Expected: FAIL — `peopleSection`, `profileSection`, `peopleFromPersons` not exported.

- [ ] **Step 3: `peopleFromPersons` + picker chips**

In `web/src/triage-map.ts` replace `peopleFromLogins` with:

```ts
import { initialsOfName } from "./people";
import type { PersonSummary } from "./api";
/** The person picker's source: the persons directory. The picked value is the handle. */
export function peopleFromPersons(persons: PersonSummary[]): Person[] {
  return persons.map((p) => ({ id: p.handle, name: p.name ?? p.handle, initials: initialsOfName(p.name, p.handle), color: p.color, avatar_url: p.avatar_url }));
}
```

In `web/src/maintenance.ts`: extend `Person` with `color?: PersonColor; avatar_url?: string | null`; in `personPicker` render the row avatar with `personChip(p.color ? { handle: p.id, name: p.name, color: p.color, avatar_url: p.avatar_url } : null, 20, p.id)` instead of `avatarCircle(p.initials)`. In `render.ts` `maintenanceProps`: `people: peopleFromPersons(s.persons.data)`. Update the existing `test/triage-map.test.ts` case that covered `peopleFromLogins` to call `peopleFromPersons` with a one-row directory.

- [ ] **Step 4: `peopleSection` in `web/src/maintenance.ts`**

```ts
export interface PeopleProps { persons: PersonSummary[]; invites: InviteRow[]; inviteDraft: string; loading: boolean; error: string | null }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function peopleSection(p: PeopleProps): string {
  const pending = p.invites.filter((i) => !i.accepted_by && !i.revoked_at);
  const count = `${p.persons.length} ${p.persons.length === 1 ? "person" : "people"}${pending.length ? ` · ${pending.length} invite${pending.length === 1 ? "" : "s"} pending` : ""}`;
  const canSend = EMAIL_RE.test(p.inviteDraft.trim());
  const row = "display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px";
  const idc = (t: string, tone: "normal" | "pending" = "normal") => `<span style="font-family:var(--mono);font-size:10.5px;padding:2px 7px;border-radius:6px;border:1px ${tone === "pending" ? "dashed" : "solid"} var(--border-strong);color:${tone === "pending" ? "var(--amber)" : "var(--fg-55)"};white-space:nowrap">${esc(t)}</span>`;
  const persons = p.persons.map((x) => `<div style="${row}">${personChip(x, 28, x.handle)}<div style="line-height:1.25"><b style="font-size:13.5px;font-weight:600;display:block">${esc(x.name ?? x.handle)}</b><span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-55)">@${esc(x.handle)}</span></div><span></span></div>`).join("");
  const invitesHtml = pending.map((i) => {
    const status = i.email_error ? `<span style="color:var(--red)">email failed: ${esc(i.email_error)}</span>` : i.email_sent_at ? "email sent" : "email not sent";
    return `<div style="${row}"><div style="width:28px;height:28px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;color:var(--fg-40);font-size:12px">?</div>
      <div style="line-height:1.25"><b style="font-size:13.5px;font-weight:500;color:var(--fg-55);display:block">${esc(i.email)}</b><span style="font-size:11.5px;color:var(--fg-40)">invited ${esc(relTime(i.invited_at))} by ${esc(i.invited_by)} · ${status}</span></div>
      <div style="display:flex;gap:6px">${idc("pending", "pending")}<button data-act="inviteResend" data-arg="${attr(i.email)}" class="cnpy-ghostbtn" style="font-size:12px;color:var(--fg-40);padding:4px 8px;border-radius:6px;border:1px solid var(--border)">Resend</button><button data-act="inviteRevoke" data-arg="${attr(i.email)}" class="cnpy-rejectbtn" style="font-size:12px;color:var(--fg-40);padding:4px 8px;border-radius:6px;border:1px solid var(--border)">Revoke</button></div></div>`;
  }).join("");
  return `${maintSectionHeader("PEOPLE", "invite a Google address; everyone with a handle is listed here", count, false)}
    <div style="display:flex;gap:8px;margin:14px 0 12px">
      <input data-act="inviteDraft" data-field="inviteDraft" value="${attr(p.inviteDraft)}" placeholder="Invite by Google email…" aria-label="Invite by Google email" class="cnpy-input" style="flex:1;height:38px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;outline:none" />
      <button data-act="inviteSend" class="cnpy-accentbtn" ${canSend ? "" : "disabled "}style="padding:0 14px;height:38px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:600;${canSend ? "" : "opacity:.45;cursor:default"}">Invite</button>
    </div>
    ${p.error ? `<div style="font-size:12.5px;color:var(--red);margin-bottom:8px">${esc(p.error)}</div>` : ""}
    ${p.loading && p.persons.length === 0 ? `<div style="font-size:12.5px;color:var(--fg-40);padding:10px 0">Loading people…</div>` : persons}
    ${invitesHtml}`;
}
```

Imports: `personChip` from `./people`, `relTime` from `./ui`, `PersonSummary` from `./api`, `InviteRow` from `@shared/rows`.

- [ ] **Step 5: `profileSection` in `web/src/render.ts`**

Extract the existing Profile `<section>` from `settingsView` into `export function profileSection(s: AppState): string` and replace its body with:

```ts
export function profileSection(s: AppState): string {
  const me = s.me;
  const handle = me?.handle ?? "";
  const has = (p: "github" | "google") => me?.identities.some((i) => i.provider === p) ?? false;
  const last = (me?.identities.length ?? 0) <= 1;
  const provRow = (p: "github" | "google", label: string) => {
    const id = me?.identities.find((i) => i.provider === p);
    const btn = id
      ? `<button data-act="unlinkProvider" data-arg="${p}" class="cnpy-ghostbtn" ${last ? "disabled " : ""}style="font-size:12px;color:var(--fg-40);padding:4px 10px;border-radius:6px;border:1px solid var(--border);${last ? "opacity:.45;cursor:default" : ""}">Unlink</button>`
      : `<button data-act="linkProvider" data-arg="${p}" class="cnpy-ghostbtn" style="font-size:12px;color:var(--fg-70);padding:4px 10px;border-radius:6px;border:1px solid var(--border-strong)">Link ${label}</button>`;
    return `<div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px"><div style="line-height:1.25"><b style="font-size:13.5px;font-weight:600;display:block">${label}</b><span style="font-family:var(--mono);font-size:11.5px;color:${id ? "var(--fg-55)" : "var(--fg-40)"}">${id ? esc(id.label) : "not linked"}</span></div>${btn}</div>`;
  };
  return `<section style="margin-bottom:14px">
    <div style="${SECTION_LABEL}">Profile</div>
    <div style="border:1px solid var(--border);border-radius:13px;padding:22px">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:22px">
        ${personChip(me ? { handle, name: s.displayName || me.name, color: me.color, avatar_url: me.avatar_url } : null, 56, handle || "?")}
        <div style="flex:1;min-width:0">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Display name</label>
          <div style="display:flex;gap:10px">
            <input data-act="setDisplayName" data-field="displayName" value="${attr(s.displayName)}" class="cnpy-input" style="flex:1;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none" />
            <button data-act="saveProfile" class="cnpy-accentbtn" style="padding:0 18px;height:40px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600">Save</button>
          </div>
          <div style="font-size:12px;color:var(--fg-40);margin-top:8px">Handle <span style="font-family:var(--mono);color:var(--fg-55)">@${esc(handle)}</span> · can't be changed</div>
        </div>
      </div>
      <div style="margin-bottom:22px"><label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Your color</label>${swatches("setMyColor", me?.color ?? "stone", true)}</div>
      <div style="${SECTION_LABEL};margin-bottom:10px">Sign-in methods <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--fg-40)">· at least one stays linked</span></div>
      ${provRow("github", "GitHub")}${provRow("google", "Google")}
    </div>
  </section>`;
}
```

Define `const SECTION_LABEL = "font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:14px";` near the other style consts in `render.ts` (it is the inline string the Profile / Appearance labels use today). `has` is used by the Account section below (`Member of ${org}` only when `has("github")`, else `Signed in with Google`), so keep it. In `settingsView` call `${profileSection(s)}` where the old section was, and drop the old GITHUB pill and "Avatar is imported from GitHub" note. The Account section keeps `Member of ${org}` only when `has("github")`; otherwise it shows `Signed in with Google`.

Other chip sites: sidebar chip → `personChip(s.me ? { handle: s.me.handle, name: s.displayName || s.me.name, color: s.me.color, avatar_url: s.me.avatar_url } : null, 30, s.me?.handle ?? "?")`; feed row avatar → `personChip(personFor(s, e.author), 30, e.author)` where `function personFor(s: AppState, handle: string) { return s.persons.data.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null; }`; the docs `updated_by` chip (line ~627) the same at size 24.

Maintenance: in `maintenanceScreen`, when `s.me?.admin`, splice `peopleSection({ persons: s.persons.data, invites: s.invites.data, inviteDraft: s.inviteDraft, loading: s.persons.status === "loading" || s.invites.status === "loading", error: s.invites.error ?? null })` BEFORE the notification sections (same `cut` splice).

- [ ] **Step 6: Loaders + dispatch in `web/src/main.ts`**

```ts
let personsSeq = 0;
function loadPersons(): void {
  const seq = ++personsSeq;
  state.persons = { status: "loading", data: state.persons.data };
  listPersons()
    .then((rows) => { if (seq !== personsSeq) return; state.persons = { status: "ok", data: rows }; rerender(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } if (seq !== personsSeq) return; state.persons = { status: "error", data: state.persons.data, error: String(e) }; rerender(); });
}
let invitesSeq = 0;
function loadInvites(): void {
  if (!state.me?.admin) return;
  const seq = ++invitesSeq;
  state.invites = { status: "loading", data: state.invites.data };
  listInvites()
    .then((rows) => { if (seq !== invitesSeq) return; state.invites = { status: "ok", data: rows }; rerender(); })
    .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } if (seq !== invitesSeq) return; state.invites = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) }; rerender(); });
}
function refreshMe(): void {
  getMe().then((me) => { state.me = me; state.displayName = me.name ?? me.handle; rerender(); }).catch(() => undefined);
}
```

Boot (`getMe().then`): call `loadPersons()` alongside the badge loads. `loadForScreen("maintenance")`: add `loadInvites()`. After a successful `mapIdentity` also `loadPersons()`. `case "goSettings"`: if `new URLSearchParams(location.search).get("link") === "conflict"` flash `"That account is already linked to someone else"` once and `history.replaceState(null, "", "/#settings")`.

Dispatch cases:

```ts
    case "saveProfile": {
      const name = state.displayName.trim() || null;
      updateMe({ name }).then((r) => { if (state.me) state.me.name = r.name; flash("Profile saved"); rerender(); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't save profile"); });
      return;
    }
    case "setMyColor": {
      if (!arg || !state.me) return;
      const color = arg as PersonColor;
      updateMe({ color }).then(() => { if (state.me) state.me.color = color; loadPersons(); rerender(); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't save color"); });
      return;
    }
    case "linkProvider": window.location.href = arg === "google" ? "/auth/google/login?link=1" : "/auth/login?link=1"; return;
    case "unlinkProvider": {
      if (arg !== "github" && arg !== "google") return;
      unlinkIdentity(arg).then(() => { flash(`${arg === "google" ? "Google" : "GitHub"} unlinked`); refreshMe(); })
        .catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash(e instanceof ApiError && e.message === "last_identity" ? "You need at least one sign-in method" : "Couldn't unlink"); });
      return;
    }
    case "inviteDraft": state.inviteDraft = value ?? ""; rerender(); return;
    case "inviteSend": {
      const email = state.inviteDraft.trim();
      if (!email) return;
      createInvite(email).then((r) => {
        state.inviteDraft = "";
        flash(r.email.status === "sent" ? `Invited ${r.invite.email} — email sent` : `Invited ${r.invite.email} — email failed: ${r.email.error ?? "unknown"}`);
        loadInvites();
      }).catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash(e instanceof ApiError && e.message === "invite_exists" ? "Already invited" : e instanceof ApiError && e.message === "already_a_person" ? "That address already belongs to a person" : "Couldn't invite"); });
      return;
    }
    case "inviteResend": { if (!arg) return; resendInvite(arg).then((r) => { flash(r.email.status === "sent" ? "Invite resent" : `Resend failed: ${r.email.error ?? "unknown"}`); loadInvites(); }).catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't resend"); }); return; }
    case "inviteRevoke": { if (!arg) return; revokeInvite(arg).then(() => { flash("Invite revoked"); loadInvites(); }).catch((e) => { if (e instanceof Unauthorized) { unauth(e); return; } flash("Couldn't revoke"); }); return; }
```

Remove the old `case "saveProfile": return;` stub. `unauth` is the existing helper at main.ts:237.

- [ ] **Step 7: Run + typecheck + build**

Run: `npx vitest run test/render.people.test.ts test/render.onboard.test.ts test/triage-map.test.ts test/render.review.test.ts test/render.mywork.test.ts && npm run typecheck && npm run build:web`
Expected: all green.

- [ ] **Step 8: Manual check with `npm run dev`**

With `DEV_LOGIN=AndresL230` in `.dev.vars`: Settings shows Profile with swatches and sign-in methods; Maintenance shows People with the four seeded persons; the feed chips carry colors. Open `/?denied=invite&email=x%40y.z` to see the not-invited card. (The onboarding screen needs a real `onboard` cookie; it is covered by the pure render test and the route tests.)

- [ ] **Step 9: Commit**

```bash
git add web/src tsconfig.worker.json tsconfig.web.json test/render.people.test.ts test/triage-map.test.ts
git commit -m "feat(web): Settings › Profile (color, sign-in methods), Maintenance › People, colored person chips"
```

---

### Task 12: Docs, env, skill, final verification

**Files:**
- Modify: `CLAUDE.md`, `.claude/skills/canopy/SKILL.md`, `wrangler.toml` (comments only), `src/env.ts` (comments), `test/env.d.ts`
- Test: none new; full suite

- [ ] **Step 1: CLAUDE.md**

- Layout › `migrations/`: append `, then \`0023_persons\` [persons / identities / invites replace users + people; sessions + mcp_tokens repoint to persons.handle; bodies table loses its outbox FK]`.
- Layout › `src/`: add `auth/` detail: `persons.ts (the identity root), google.ts (second provider), onboard.ts (the sign-in fork + onboarding cookie), invites.ts`.
- Auth section: rename the heading to **Auth — three classes, two providers in the session class (fully built — don't add a class)** and replace the Session cookie bullet with:
  > **Session cookie** (humans, the Hono app): signed cookie; every route except the public auth paths passes `sessionGate`. The principal is `{ handle }`. Two providers feed ONE fork (`src/auth/onboard.ts` `completeSignIn`): **GitHub** (OAuth + PKCE, gated to active `SaplingLearn` members) and **Google** (OAuth + PKCE, ID token verified against Google's JWKS, gated to admin **invites**). The fork: known identity → session; verified email matches a person → link + session; invited (or GitHub member) → onboarding (a sealed 10-minute `onboard` cookie; the person row is created only on `POST /auth/onboard` with handle + color); else denied. Link mode (`?link=1` with a session) attaches a second provider in Settings; the last identity can't be unlinked.
- Add a paragraph **Identity — persons, not logins** after Auth:
  > `persons` (handle PK, chosen once, immutable; name, color, email) is the root. `identities(provider, subject) → person` holds the GitHub login and Google `sub`. Event subjects (`events.subject_login`) resolve to a person through the github identity row at read time (`resolvePersonForLogin`); an unmapped login raises an `identity_tasks` row and Maintenance › Identity links it to an existing handle. `ADMIN_LOGINS` holds handles. Every `recorded_by` / `created_by` / `user_id` is a handle. Migrated GitHub users kept their login as handle.
- Email notifications: add a bullet **Invite email** (`src/notifications/invite.ts`): one transactional message per invite/resend through `deliveryFor`; not a kind; outcome on `invites.email_*`; no `List-Unsubscribe` headers (they are optional on `OutboundMessage` now).
- Env: add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (secrets; absent → `/auth/google/login` returns 503).
- Conventions: replace the `people` mention in the reset-table list with `persons`, `identities`, `invites`.
- Deferred, say so in the Email notifications section: the digest's ledger layout has no avatar chips today, so the person color does not appear in email yet. When a chip is added to `EMAIL_CARD.item`, take the color from `persons.color` via the light hex set in §7 of the spec.

- [ ] **Step 2: Skill + env comments**

- `.claude/skills/canopy/SKILL.md`: in the authority-model paragraph say the writer identity is the person's **handle** (GitHub login for migrated engineers).
- `src/env.ts`: add `GOOGLE_CLIENT_ID?: string; // Google OAuth client (second session-class provider); absent → /auth/google/login 503s` and `GOOGLE_CLIENT_SECRET?: string;`.
- `wrangler.toml`: comment under `[vars]` noting the two Google secrets go through `wrangler secret put`.
- `test/env.d.ts`: already extended in Task 4; confirm.

- [ ] **Step 3: Final verification**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .claude/skills/canopy/SKILL.md src/env.ts wrangler.toml test/env.d.ts
git commit -m "docs: person-centric identity, Google provider, invites"
```

---

## Deployment notes (not tasks — for the human)

1. Create a Google OAuth client (Web application) with redirect URI `https://canopy.saplinglearn.com/auth/google/callback` (and `http://localhost:8787/auth/google/callback` for dev). `wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. `npm run db:migrate:remote` applies 0023. It is not reversible; take a `wrangler d1 export` first (drop the `*_fts` tables around the export as 0011 documents).
3. After deploy, open Maintenance › Identity: any `people` row the migration could not match now shows as a pending login to map.
