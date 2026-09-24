# MCP OAuth — sign in to Canopy from Claude Code, then claude.ai

Status: design approved in brainstorming 2026-09-24; spec awaiting review.

## Goal

Connect an MCP client to Canopy the way claude.ai connectors connect: add the URL, sign in in a
browser, click Allow — no pasted token, no `CANOPY_MCP_TOKEN` environment variable.

- **Phase 1 — Claude Code.** The plugin's `.mcp.json` carries no `headers`; `/mcp` → Authenticate opens
  a browser, the person signs in with GitHub/Google (the existing gate), approves, and the plugin works.
- **Phase 2 — claude.ai.** The same server is added as a custom connector
  (`https://canopy.saplinglearn.com/mcp`) and each person connects through the same consent screen.

Both clients speak the MCP authorization spec (protected-resource metadata, authorization-server
metadata, dynamic client registration, authorization code + PKCE, refresh tokens), so this is ONE OAuth
layer, built and verified against Claude Code first; phase 2 is verification plus client quirks.

### Success criteria

1. A new teammate installs plugin v0.4.0, runs `/mcp` → Authenticate, signs in, clicks Allow, and every
   Canopy MCP tool works as that person.
2. An existing `canopy_mcp_` bearer token keeps working unchanged.
3. A person can see and revoke each connection in Settings; revoking stops it on the next call.
4. Phase 2: Canopy connects as a claude.ai custom connector on the Team plan.

### Non-goals

- Fine-grained scopes. One scope, `mcp` = the person's full MCP powers (including admin tools for an
  admin — the existing per-tool admin gating is unchanged).
- A new auth class. OAuth is a way to OBTAIN a bearer token; `/mcp` stays the bearer class. The session
  cookie and webhook classes are untouched.
- Replacing `canopy_mcp_` tokens. They stay, for headless clients (CI, Codex, scripts).
- A third-party identity provider or `@cloudflare/workers-oauth-provider` (rejected: a KV binding outside
  D1, and it wraps the Worker's whole `fetch` export, which conflicts with `src/index.ts`'s dispatch).
- Remembered consent. Every authorization shows the consent screen.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Existing `canopy_mcp_` tokens | Keep both. OAuth is the default; pasted tokens remain for headless use. |
| Consent | Always shown, every authorization. |
| Token lifetimes | Access 1 h; refresh rotating, 90 days idle; Settings lists and revokes connections. |
| Implementation | Hand-rolled, stored in D1. |

## Architecture

New units:

- `src/auth/oauth.ts` — the core: client registration, code issue/exchange, token mint/refresh/revoke,
  bearer resolution, pruning. D1 only, no `fetch`; every function takes `now` as a parameter so tests
  control the clock.
- `src/auth/oauth-routes.ts` — the HTTP surface, mounted on the Hono app.
- `src/auth/oauth-pages.ts` — the two server-rendered pages (sign-in interstitial, consent) and the
  error page, as pure `string` templates.
- `migrations/0029_oauth.sql`.

Changed units:

- `src/auth/principal.ts` — `resolveBearerPrincipal` dispatches on the token prefix: `canopy_mcp_` →
  `resolveToken` (unchanged), `canopy_oat_` → `resolveOAuthAccessToken`. Both return `{ handle }`.
  `PUBLIC_PATHS` gains the OAuth endpoints that take no cookie.
- `src/index.ts` — the `/mcp` 401 gains `WWW-Authenticate` (below). The "bare 401, NO discovery"
  comment is replaced.
- `src/auth/onboard.ts` / the GitHub + Google callbacks + `POST /auth/onboard` — honour the
  `oauth_pending` cookie (below).
- `src/auth/persons.ts` — `HANDLE_COLUMNS` gains `oauth_codes.person` and `oauth_grants.person`.
- `src/repo/cron.ts` — the 6-hourly `:30` tick also calls `pruneOAuth` (D1 only, no subrequests).
- `scripts/seed/reset.mjs` — truncates the four new tables.
- `web/src/render.ts` — Settings › Connected apps card; the Get connection command modal gains a first
  option, "Sign in with browser (recommended)".
- `plugins/canopy/.mcp.json` — `headers` removed; `plugin.json` → 0.4.0, description no longer mentions
  `$CANOPY_MCP_TOKEN`.
- `CLAUDE.md` — Auth section (bearer class), the bare-401 line, the deferred-seams line.

### The flow

1. Client calls `/mcp` without a token → `401` with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
2. `GET /.well-known/oauth-protected-resource` →
   `{ resource: "<origin>/mcp", authorization_servers: ["<origin>"], scopes_supported: ["mcp"],
   bearer_methods_supported: ["header"] }`.
3. `GET /.well-known/oauth-authorization-server` →
   `{ issuer, authorization_endpoint: "<origin>/oauth/authorize", token_endpoint: "<origin>/oauth/token",
   registration_endpoint: "<origin>/oauth/register", revocation_endpoint: "<origin>/oauth/revoke",
   response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
   code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
   scopes_supported: ["mcp"] }`.
4. `POST /oauth/register` → `201 { client_id, client_name, redirect_uris,
   token_endpoint_auth_method: "none", grant_types, response_types }`. Public clients only; no secret.
5. Browser → `GET /oauth/authorize?...` → (sign-in if needed) → consent → Allow →
   `302 redirect_uri?code=…&state=…`.
6. `POST /oauth/token` (`grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`,
   `client_id`) → `{ access_token: "canopy_oat_…", token_type: "Bearer", expires_in: 3600,
   refresh_token: "canopy_ort_…", scope: "mcp" }`.
7. `/mcp` with `Bearer canopy_oat_…` → principal `{ handle }`, exactly as today.

`<origin>` is the request's own origin (`new URL(request.url).origin`), so the flow works under
`wrangler dev` and in prod without a var.

## Data model — `migrations/0029_oauth.sql`

```sql
CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,          -- random, 32 bytes base64url
  client_name   TEXT NOT NULL,             -- self-reported, cut to 80 chars
  redirect_uris TEXT NOT NULL,             -- JSON array, 1..5
  created_at    TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,         -- SHA-256 of the raw code
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id),
  person         TEXT NOT NULL REFERENCES persons(handle),
  grant_id       INTEGER NOT NULL,         -- the grant created at consent
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,            -- S256 only
  resource       TEXT,                     -- NULL when the client sent none
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,            -- created + 60 s
  used_at        TEXT
);

CREATE TABLE oauth_grants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person         TEXT NOT NULL REFERENCES persons(handle),
  client_id      TEXT NOT NULL,            -- no FK: grants outlive pruned clients
  client_name    TEXT NOT NULL,            -- snapshot at consent
  created_at     TEXT NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT                      -- 'user' | 'reuse'
);
CREATE INDEX idx_oauth_grants_person ON oauth_grants(person);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,             -- SHA-256 of the raw token
  grant_id   INTEGER NOT NULL REFERENCES oauth_grants(id),
  kind       TEXT NOT NULL,                -- 'access' | 'refresh'
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                -- access +1 h; refresh +90 d
  rotated_at TEXT                          -- refresh only
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens(grant_id);
```

Every raw secret (code, access token, refresh token) is shown once and stored only as its SHA-256 hash,
the same rule as `mcp_tokens`. Token prefixes: `canopy_oat_` (access), `canopy_ort_` (refresh); the
random part is 32 bytes via the existing `randomToken`.

## Endpoints

All OAuth endpoints answer standard OAuth errors as JSON `{ error, error_description? }` — never a
500, never a stack. No raw code, token, verifier or challenge is ever logged.

### Metadata — `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server`

Public, cacheable (`cache-control: public, max-age=3600`), `Access-Control-Allow-Origin: *`. Also
answered at `/.well-known/oauth-protected-resource/mcp` (the path-suffixed form some clients request).

### `POST /oauth/register` — dynamic client registration

Public, CORS `*`, JSON body. Limits — any breach is `400 invalid_client_metadata` and writes nothing:

- body ≤ 8 KB;
- `redirect_uris` 1–5 entries, each an absolute URL that is either `https:` or loopback `http:` with
  host `127.0.0.1`, `[::1]` or `localhost` (any port); no fragment;
- `token_endpoint_auth_method`, if present, must be `none`;
- `grant_types` / `response_types`, if present, must be subsets of the supported ones;
- `client_name` defaults to `"Unnamed client"`, is trimmed and cut to 80 characters.

No rate limit (Canopy has none anywhere); unused registrations are pruned after 24 h.

### `GET /oauth/authorize`

Validation, in order:

1. `client_id` unknown, or `redirect_uri` not a registered URI (exact; a loopback `http:` URI matches on
   any port) → render the **error page** (400). Never redirect — this is what keeps authorize from being
   an open redirector.
2. Anything else wrong — `response_type ≠ code`, no `code_challenge`, `code_challenge_method ≠ S256`,
   `state` longer than 1024 characters, `resource` present and ≠ `<origin>/mcp` — → `302 redirect_uri?
   error=invalid_request&error_description=…&state=…`.

Then:

- **No session** → set the `oauth_pending` cookie (sealed like `onboard`: HttpOnly, Secure, SameSite=Lax,
  10-minute expiry, holds the validated query string) and render the **sign-in interstitial**: "Sign in to
  Canopy to connect *<client name>*" with GitHub and Google buttons linking `/auth/login` and
  `/auth/google/login`.
- **Session** → render the **consent page** (below).

### Sign-in return (`oauth_pending`)

After the GitHub or Google callback reaches a session (`completeSignIn` → known identity or link), and
after `POST /auth/onboard` creates a person, the handler checks `oauth_pending`: if present and unexpired
it clears the cookie and redirects to `/oauth/authorize?<stored query>` (re-validated there) instead of
the SPA. Denied sign-ins behave exactly as today. The `onboard` step's JSON response gains an optional
`redirect` field the SPA follows when present.

### Consent page and `POST /oauth/authorize`

Server-rendered HTML, inline styles using Canopy's colour tokens, `Content-Security-Policy:
frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self' <redirect
origin>`, `X-Frame-Options: DENY`, `cache-control: no-store`. It shows:

- the client name, labelled "(name supplied by the app)";
- the redirect host (`localhost`, `claude.ai`, …);
- "will act as **@handle**";
- "It can do everything you can do in Canopy through MCP — read, file and update tickets, stage docs,
  and, for an admin, edit the plan and sprints. You can disconnect it any time in Settings."

Allow and Deny `POST /oauth/authorize` with the original parameters plus `csrf` =
HMAC-SHA256(`COOKIE_SECRET`, session id + canonical parameter string). The POST re-runs the GET's
validation, checks the session and the CSRF value (constant-time); a mismatch is the error page (403).

- **Deny** → `302 redirect_uri?error=access_denied&state=…`.
- **Allow** → insert an `oauth_grants` row (`client_name` snapshot) and an `oauth_codes` row carrying
  its `grant_id`, then `302 redirect_uri?code=…&state=…`. The grant exists from consent; the code
  exchange mints the first token pair on it. A code never exchanged leaves a grant with no tokens — it
  lists in Settings as "never used" and can be revoked like any other.

### `POST /oauth/token`

Public, CORS `*`, `application/x-www-form-urlencoded` (JSON also accepted).

**`grant_type=authorization_code`**

1. ONE statement: `UPDATE oauth_codes SET used_at = now WHERE code_hash = ? AND used_at IS NULL AND
   expires_at > now RETURNING …`. No row → `400 invalid_grant`.
2. `client_id` and `redirect_uri` must equal the code's; `BASE64URL(SHA-256(code_verifier))` must equal
   `code_challenge`; `resource`, if sent, must equal the code's (or `<origin>/mcp` when the code has
   none). Any mismatch → `400 invalid_grant`, and the code stays burned.
3. The grant must be unrevoked. Mint an access token (+1 h) and a refresh token (+90 d) on it.

**`grant_type=refresh_token`**

1. Look up the refresh token by hash, joined to its grant. Unknown, expired, wrong `client_id`, or a
   revoked grant → `400 invalid_grant`.
2. `rotated_at IS NULL` → ONE conditional `UPDATE … SET rotated_at = now WHERE token_hash = ? AND
   rotated_at IS NULL`; if it changed a row, mint a new pair (refresh `expires_at` = now + 90 d — this is
   the idle window) and return it. If it changed nothing, another request rotated it first: fall through
   to step 3.
3. **Reuse interval.** `rotated_at` within the last 60 s → mint another fresh pair on the same grant
   (concurrent refreshes from several Claude Code sessions sharing one stored credential). Older than
   60 s → set `revoked_at = now, revoked_reason = 'reuse'` on the grant and return `400 invalid_grant`.

Unsupported `grant_type` → `400 unsupported_grant_type`.

### `POST /oauth/revoke` (RFC 7009)

Public, CORS `*`. `token` may be an access or a refresh token. A refresh token revokes its grant
(`revoked_reason = 'user'`); an access token is expired in place (`expires_at = now`). Always `200`,
including for an unknown token.

### `/mcp`

- No / malformed `Authorization` → `401` + `WWW-Authenticate: Bearer resource_metadata="…"`.
- A `canopy_oat_` token that is unknown, expired, or on a revoked grant → `401` +
  `WWW-Authenticate: Bearer resource_metadata="…", error="invalid_token"`.
- A `canopy_mcp_` token behaves exactly as today except that its 401 also carries the header.

`resolveOAuthAccessToken` is ONE statement joining `oauth_tokens` → `oauth_grants`
(`kind = 'access' AND expires_at > now AND revoked_at IS NULL`). It bumps `oauth_grants.last_used_at`
only when the stored value is older than 60 s, so ordinary MCP traffic is not a write per call.

## Settings

Session-cookie routes, never MCP tools:

- `GET /auth/oauth-grants` → the caller's unrevoked grants, newest first:
  `{ id, client_name, created_at, last_used_at }`.
- `POST /auth/oauth-grants/:id/revoke` → revokes the caller's OWN grant (`revoked_reason = 'user'`);
  someone else's id and an unknown id are the same `404`.

Settings › **Connected apps** card beside the token list: one row per grant — name, "connected <date>",
"last used <date>", Revoke. Empty state: "No apps connected. Use *Get connection command* → Sign in with
browser." Any new border radius gets its line in the corners block (`test/render.corners.test.ts`).

**Browser-connect lives in the Settings tile, not the modal.** The Get connection command modal mints on
open, so the "Sign in with browser" command is shown in the Settings tile (renamed "MCP access") above
the token list, with a Copy button that mints nothing. The Connected apps list lives in the same tile.
The modal is unchanged.

## Housekeeping

`pruneOAuth(db, now)` on the repo cron's 6-hourly `:30` tick, beside `pruneRepoCapture`, D1 only:

- codes whose `expires_at` or `used_at` is more than 1 h old;
- access tokens more than 24 h past `expires_at`;
- refresh tokens rotated more than 24 h ago, or past `expires_at`;
- clients older than 24 h with no grant.

Grants are never deleted — a revoked grant is the audit trail (soft, like every other exit in Canopy).

## Phase 2 — claude.ai

Nothing above is Claude-Code-specific; phase 2 checks the differences:

1. **Redirect URI.** claude.ai registers an `https://claude.ai/…` callback (believed to be
   `https://claude.ai/api/mcp/auth_callback`; confirm against Anthropic's connector docs). The generic
   `https:` rule already admits it — no allowlist entry needed.
2. **Server-to-server calls.** The token exchange and the MCP traffic come from Anthropic's servers, not
   the browser. Canopy has no IP allowlist; the owner confirms that Cloudflare bot protection / WAF on the
   zone does not challenge `/oauth/token` or `/mcp`.
3. **`resource`.** It may be omitted; that is accepted (above).
4. **Setup.** On the Team plan an org owner adds the custom connector once
   (`https://canopy.saplinglearn.com/mcp`); each person then connects and sees the consent screen.

Phase 2 ships whatever small fixes that verification turns up, plus a CLAUDE.md note.

## Testing

Vitest against real Miniflare D1, no network (`test/oauth.*.test.ts`):

- full flow end to end with a real PKCE pair, ending in a `/mcp` call that resolves the right handle;
- `/mcp` 401 carries `WWW-Authenticate` with the right metadata URL; metadata docs' shape;
- register: accepted shapes, every rejection (size, count, scheme, non-loopback http, fragment, auth
  method), and that a rejection writes nothing;
- authorize: unknown client and mismatched redirect render the error page and never redirect; other bad
  parameters redirect with `invalid_request` and `state`; signed-out sets `oauth_pending`; consent POST
  rejects a bad CSRF value; Deny → `access_denied`;
- `oauth_pending` round trip through a known-identity sign-in and through `POST /auth/onboard`;
- token: code reuse, expired code, wrong verifier, `redirect_uri` / `client_id` / `resource` mismatch,
  unsupported grant type;
- refresh: rotation returns a new pair and extends the idle window; reuse within 60 s → a fresh pair;
  after 60 s → grant revoked and its live access token stops resolving; expired refresh token;
- revoke endpoint (both kinds, unknown token → 200); Settings revoke of own vs someone else's grant;
- `canopy_mcp_` tokens resolve unchanged; `last_used_at` throttling;
- handle rename carries grants and codes; `pruneOAuth` rules;
- a render test for the Connected apps card and the modal's new option.

Plus `npm run typecheck`, and a live check: `/mcp` → Authenticate against `wrangler dev`
(`http://localhost:8787/mcp`), then against prod after merge.

## Rollout

1. Phase 1 PR: migration 0029, the OAuth layer, Settings, plugin 0.4.0, CLAUDE.md. Apply `0029` to
   prod (`db:migrate:remote`) before or with the merge — a merge to `main` deploys.
2. Owner verifies in Claude Code against prod; teammates update the plugin and drop `CANOPY_MCP_TOKEN`.
3. Phase 2: add the claude.ai connector, verify, fix, document.

## Amendments (from planning, 2026-09-24)

1. **Loopback redirect ports.** A loopback `http:` redirect matches a registered loopback URI on scheme + host + path + query, ANY port (RFC 8252 §7.3) — Claude Code picks a fresh port per attempt. `https:` redirects stay exact-match. The code exchange still requires the redirect to equal the one used at authorize, exactly.
2. **Scope is lenient.** An unknown `scope` value is ignored, not an error; every token is issued with scope `mcp` (RFC 6749 §3.3 permits the server to narrow). Reduces claude.ai interop risk.
3. **Browser-connect lives in the Settings tile, not the modal.** The Get connection command modal mints on open, so the "Sign in with browser" command is shown in the Settings tile (renamed "MCP access") above the token list, with a Copy button that mints nothing. The Connected apps list lives in the same tile. The modal is unchanged.
4. **`state` is capped at 1024 characters** so the `oauth_pending` cookie can never outgrow a browser's cookie limit.
5. **Token-endpoint unexpected error** → `503 temporarily_unavailable` (spec said "never a 500" without naming the fallback).
