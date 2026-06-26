## Database

Sapling uses **Supabase (PostgreSQL)** as its only persistent data store. The backend connects exclusively through the service-role key (`SUPABASE_SERVICE_KEY`) via a PostgREST helper in `backend/db/connection.py`. The service role bypasses Supabase RLS, which is intentional — all authorization is enforced in application code before the query is issued, not at the database policy layer (RLS is enabled on all public tables to lock out the `anon` and `authenticated` roles, applied to production as of 2026-06-13; see `docs/security/rls-lockdown-plan.md`).

### Schema & migrations

Schema lives in `backend/db/migrations/` as numbered SQL files (`0001`–`0028`). A minimal runner (`backend/db/migrate.py`) connects via `psycopg` on the **direct Supabase connection string** (`SUPABASE_DB_URL`, port 5432, never the pooler) — this is the only place outside `db/connection.py` that opens a database connection, because PostgREST cannot execute DDL. The runner records applied files in a tracking table, so re-runs are safe.

### DB modular redesign (migrations 0019–0028)

Migrations 0019–0028 represent a full target-schema sweep landed in the `epic/db-modular-redesign` branch (validated end to end on staging as of 2026-06-24, awaiting `epic → main` cutover):

- **0019** — shared conventions: a reusable `set_updated_at()` trigger function; new `schools` and `terms` tables with seeded canonical terms (Fall 2025 through Fall 2026).
- **0020** — academics split: the existing `courses` table (which was offering-shaped) is renamed to `course_offerings`; a new abstract `courses` catalog table is created; `user_courses` becomes `enrollments` keyed on `offering_id`. The public API boundary still keys on the abstract `course_id`.
- **0021** — gradebook re-keyed onto `enrollment_id` (semester-aware grades, curve, drop-lowest).
- **0022** — analytics re-keyed onto `course_offerings`.
- **0023** — knowledge graph: UNIQUE-backed upserts and an append-only `node_mastery_events` event log; graph writes still flow through `apply_graph_update`.
- **0024** — identity split: public profile fields moved out of `users` into a dedicated `user_profiles` table; `users` slimmed to identity + auth + activity columns; `oauth_tokens.expires_at` retyped to `TIMESTAMPTZ`.
- **0025–0028** — study-artifact integrity, ops cleanup (text/uuid PKs on `feedback`/`issue_reports`, FK fixes), Gradescope import table, and dropping a vestigial `course_offerings.course_code NOT NULL` constraint.

---

## Encryption

All sensitive columns are encrypted with **AES-256-GCM** via Python's `cryptography` library (`cryptography.hazmat.primitives.ciphers.aead.AESGCM`). Implementation lives in `backend/services/encryption.py`.

**Primitive details:**
- Key: 32 bytes loaded from `ENCRYPTION_KEY` (must be exactly 64 hex characters; any other shape raises `RuntimeError` at import time and prevents the app from booting).
- Nonce: 12 random bytes from `os.urandom()` per call — never reused.
- Wire format: `base64(nonce || ciphertext_with_tag)`. The 16-byte GCM authentication tag is embedded in the ciphertext blob, so any tampered byte is detected on decrypt.

**Helper surface:**
- `encrypt` / `decrypt` — plain string round-trip.
- `encrypt_if_present` / `decrypt_if_present` — passes `None` through; the decrypt fallback returns the raw value with a structured warning log when it cannot decrypt (enabling gradual backfills without a service break).
- `encrypt_json` / `decrypt_json` — compact JSON serialization then encrypt.
- `decrypt_numeric` — decrypt then cast to `float`; passes through native numerics for columns that were retyped from `NUMERIC` to `TEXT` (migration 0017).

**Encrypted columns** (verified against `backend/routes/`):

| Table | Column(s) |
|---|---|
| `user_profiles` | `name`, `first_name`, `last_name`, `bio`, `location` |
| `oauth_tokens` | `access_token`, `refresh_token` |
| `documents` | `summary`, `concept_notes` |
| `messages` | `content` (tutor chat history) |
| `room_messages` | `text` (study-room chat) |
| `sessions` | `summary_json` |
| `assignments` | `notes`, `points_possible`, `points_earned` |
| `calendar_*` | assignment `notes` |

Migration `0017` (`migration_encryption_text_columns.sql`) retyped columns whose original types (`NUMERIC`, `JSONB`) could not hold base64 strings, preserving existing values via `USING column::TEXT`. The idempotent backfill walker (`backend/db/backfill_encryption.py`) re-encrypts legacy plaintext rows without downtime; `--apply` is required to write, and `--table` scopes to one table.

All Gemini callers decrypt to plaintext before constructing a prompt. No encrypted column value is passed verbatim into an LLM call.

---

## Observability

### Logfire

[Logfire](https://logfire.pydantic.dev) is the primary ops/tracing layer. It auto-instruments **Pydantic AI agent runs and tool calls** and **FastAPI requests** with zero manual span creation. When `LOGFIRE_TOKEN` is set, traces ship to `logfire.pydantic.dev`; without the token, Logfire stays local-only. The scrubber (below) fires regardless of whether the token is set.

**`genai-prices`** integrates with Logfire to provide per-call LLM cost telemetry (token counts and USD cost per model call), surfaced as span attributes.

### Custom span scrubber

`backend/services/logfire_scrubber.py` is wired via `logfire.configure(scrubbing=ScrubbingOptions(callback=scrub_value, extra_patterns=EXTRA_PATTERNS))`. Its purpose: Pydantic AI writes full prompt text and model output into span attributes. For Sapling that means uploaded document text — containing student PII — flowing to `logfire.pydantic.dev`.

The scrubber intercepts attributes whose JsonPath contains any of the risky tokens (`prompt`, `completion`, `messages`, `all_messages_events`, `content`, `gen_ai.prompt`, `gen_ai.completion`, `ai.input.messages`, `ai.output.value`, `user_prompt`, `input.value`, `output.value`). For matching attributes, it applies `_sanitize`:

```python
# strings longer than 80 chars become:
f"{value[:80]}…[redacted, {len(value)} chars, sha256:{fingerprint_text(value, length=16)}]"
```

Lists and dicts are recursed into. For non-risky attributes that match Logfire's built-in patterns (e.g. `password`, `api_key`), the callback returns `None`, deferring to Logfire's full-redaction behavior. The SHA-256 fingerprint comes from `backend/services/fingerprint.py` — the same helper used for quiz-drift log warnings — enabling cross-log correlation without shipping the body.

### Per-request correlation IDs (ADR-0009)

`backend/services/request_context.py` provides `RequestIDMiddleware`, added **outermost** in `backend/main.py` so every response is tagged. The middleware:

1. Reads `X-Request-ID` from the incoming request; accepts caller-supplied IDs matching `^[A-Za-z0-9_\-]{8,128}$`, generates a `uuid4` otherwise.
2. Stashes the ID on `request.state.request_id` and in a `contextvars.ContextVar` (accessible anywhere without parameter threading via `current_request_id()`).
3. Echoes the ID back as `X-Request-ID` on every response, including error responses and SSE error events.

Three global exception handlers include `request_id` in the JSON error body. The streaming `/upload` route's SSE error events also carry the middleware ID, so a user pasting an error toast can be looked up directly in Logfire.

### Planned: usage analytics (cohort #115–#122)

A planned observability expansion will write curated domain events to owned Supabase tables (`events` and `llm_usage`) in a fire-and-forget async path. No raw content is stored — only SHA-256 fingerprints reusing the scrubber helper. The `llm_usage` table will capture per-call token counts and computed cost per model/feature. This supplements Logfire's ops traces with queryable usage and cost rollups. See `docs/observability-logging-tracking.md`.

---

## Security

The backend security wave (audit #136 P0/P1s) shipped 2026-06-24. Both P0 data-exposure bugs are closed:

- **P0 #123** — calendar export IDOR: all calendar queries now scoped by `user_id`.
- **P0 #124** — study-room realtime chat displayed ciphertext instead of decrypting: REST re-fetch now routes through the decrypting backend endpoint before render.

Additional hardening from the same wave: cross-user document leak closed (`search_course_materials` user-scoped, #125); encryption boundary gaps filled at write-time for syllabus notes and at read-time for gradebook/profile responses (#126); fail-closed config validation (#174); OCR endpoint gated with auth + 15 MB size cap + rate limit (#182); profile route gating + cookie-domain CSRF fix (#189/#190); gemini-test and careers/newsletter routes gated (#198/#199); issue-screenshot upload routed through an auth-gated backend (#231); project-wide RLS lockdown applied to production (#231, `docs/security/rls-lockdown-plan.md`).

See `SECURITY.md` for the full security reference.

---

## Deploy

**Frontend** is deployed to **Cloudflare Workers** via `@opennextjs/cloudflare`. The Next.js app is built with `npm run cf:build` (OpenNext adapter) and deployed with `npm run cf:deploy`. TLS terminates at the Cloudflare edge for `*.saplinglearn.com`.

**Staging environment (#100, shipped 2026-06-24):** `frontend/wrangler.toml` defines a `[env.staging]` block that points `NEXT_PUBLIC_API_URL` and `BACKEND_URL` at `https://api.staging.saplinglearn.com` and scopes cookies to `.staging.saplinglearn.com` (preventing prod/staging session cross-contamination). Staging uses a separate Supabase project with its own `ENCRYPTION_KEY`. A configurable `ALLOWED_EMAIL_DOMAINS` env var lets the staging backend accept non-`bu.edu` accounts for internal testing. An idempotent seed script (`backend/db/seed_staging.py`) populates a fake demo dataset (graph, gradebook, courses-with-term) against the modular schema.

**Backend** runs as a containerized FastAPI app (`backend/Dockerfile`); `docker-compose.yml` wires the service for local development.
