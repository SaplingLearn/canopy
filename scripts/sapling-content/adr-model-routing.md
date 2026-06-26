## Context

Until this ADR every worker agent hardcoded `gemini-2.5-flash` via `google_model("gemini-2.5-flash")`. That was reasonable for V1 — one model, easy to reason about — but it left costs on the table. The 7-way document classifier and short-form summary generation are both tasks where Flash is overkill; Flash-Lite handles them at meaningfully lower cost. Concept extraction and syllabus parsing, by contrast, benefit from full Flash due to schema constraints, date parsing, and structured-list outputs. Hardcoding the model in each module also meant any model swap required a code edit and a redeploy.

## Decision

Replace `google_model(name)` with a task-keyed selector in `backend/agents/_providers.py::model_for(task)`. The default routing table is:

| Task | Default model |
|---|---|
| classifier | `gemini-2.5-flash-lite` |
| summary | `gemini-2.5-flash-lite` |
| concepts | `gemini-2.5-flash` |
| syllabus | `gemini-2.5-flash` |

Operators override any task via env var: `SAPLING_MODEL_<TASK_UPPER>` (e.g. `SAPLING_MODEL_CLASSIFIER=gemini-2.5-pro`). Selection happens at module import (process start) — changes require a restart, not a redeploy. `google_model(name)` stays as a back-compat shim so callers that want to pin a specific model can bypass the selector.

Cost telemetry comes for free: `genai-prices` is a transitive dependency of `pydantic-ai-slim[google]`, and Logfire's `instrument_pydantic_ai()` auto-attaches `gen_ai.usage.input_tokens`, `output_tokens`, and `gen_ai.cost.usd` to every span.

## Rationale

Two lighter tasks (classify, summarize) can run on a cheaper model with no meaningful quality loss. A 40–60% Gemini spend reduction on those steps is estimated. Centralizing selection in `model_for(task)` also makes A/B testing model choices an env-var change rather than a code change, and Logfire's per-task spans make cost attribution straightforward.

## Consequences

- (+) Estimated 40–60% Gemini spend reduction on the classifier and summary steps with no behavior regression.
- (+) Model swaps are an env-var change — can A/B Flash vs Flash-Lite vs a fine-tuned model without touching code.
- (+) Per-task telemetry rolls up cleanly in Logfire because each agent run is its own span tagged with the model name.
- (−) Gemini Flash-Lite has lower-quality outputs on edge cases. A 25-case classifier eval set was added alongside this ADR to catch regressions before they ship.
- (−) Process restart required for model changes. Acceptable — models are not swapped per request, and a bounce is a ~30s operation.
- (−) The defaults are opinionated guesses; after a quarter of production data, revisit.
