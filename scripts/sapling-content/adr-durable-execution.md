## Context

The agentic upload pipeline is in-memory only. If a FastAPI worker process dies mid-upload — pod restart, OOM kill, deploy rollover — the user's upload is lost and they must retry from scratch, re-paying for OCR, classification, concept extraction, syllabus parsing, and graph update. At Sapling's early scale this is tolerable: few users hit a flaky upload, the retry cost is bounded, and users accept that uploads can fail. As the user base grows and pipeline steps multiply (especially once the chat tutor agent spawns downstream artifacts), re-running becomes expensive and the failure mode stops being acceptable.

Pydantic AI has first-class integrations with two durable-execution frameworks: DBOS and Temporal. This ADR makes the choice explicit and defines the activation path.

## Decision

Adopt DBOS Transact (`pydantic-ai-dbos`) when conditions are met. A shim module (`backend/services/durable.py`) ships with `@workflow` and `@step` decorators that:

- Activate as real DBOS decorators when `DBOS_ENABLED=true`, the `dbos` package is importable, and `DBOS_DATABASE_URL` is set.
- Otherwise, no-op as identity passthroughs — code runs identically to pre-ADR behavior.

`@durable_workflow` is applied to `agents.document.process_document`. Each agent run inside `_run_workers` is wrapped with `@durable_step` (`_step_classify`, `_step_summary`, `_step_concepts`, `_step_syllabus`). With DBOS active, a worker crash mid-`asyncio.gather` resumes at the last completed step rather than re-running the whole workflow.

DBOS is preferred over Temporal because it is in-process (no separate worker tier), requires only Postgres for state storage (which Sapling already runs via Supabase), and has a first-party Pydantic AI integration.

**Streaming-route asymmetry (intentional):** The streaming `POST /api/documents/upload` route bypasses `process_document` and calls each agent inline to emit SSE progress events between phases. Those inline calls are NOT wrapped in the durable workflow — only `/upload/sync` gets durability. SSE connections are per-process; if the worker crashes, the client's stream is gone before any resume could deliver events. Re-running the whole pipeline on the next client retry (deduplicated by `X-Request-ID`) is the correct semantic.

## Rationale

The shim approach lets the codebase adopt the durability contract without blocking on operational readiness. The default is safe (no-op), and operators can activate DBOS by setting three env vars and running a migration — no code changes required.

## Consequences

- (+) Zero behavior change until DBOS is explicitly activated; existing tests pass unchanged.
- (+) When activated, mid-pipeline crashes resume at the last completed step rather than restarting from zero.
- (+) Idempotency keys (per ADR-0009 + the `documents.request_id` migration) compose with DBOS — a restarted workflow re-checks the idempotency cache before re-running.
- (−) Activation requires a dedicated Postgres schema for DBOS metadata (cannot reuse Supabase RLS tables), a dependency install (`pip install dbos`), and a migration step.
- (−) The streaming upload route does not get durability; this is intentional but means durable streaming UX requires the two-phase design from ADR-0010.
- (−) Test coverage for resume behavior and production validation of DBOS activation remain outstanding.
