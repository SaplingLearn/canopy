## Context

Every LLM call in the Sapling backend historically went through `services/gemini_service.py` as bare `google-genai` calls returning unstructured strings that callers parsed downstream. As features grew — document classification, concept extraction, quiz generation, syllabus parsing, tutor chat — the seam began leaking: output parsing, retries, structured output, and tool calling were reimplemented per route. Streaming progress to the client was custom per endpoint. The pattern did not scale to where the product was heading.

## Decision

Adopt Pydantic AI (`pydantic-ai-slim[google]`) as a thin framework wrapping `google-genai`. New agents live in `backend/agents/`. The existing `services/gemini_service.py` is retained as-is during migration; agents are introduced one refactor at a time. Streaming uses `agent.run_stream_events()`. Multi-step flows use agent delegation. Observability uses Logfire. Model selection stays Gemini-only — provider portability is not a paid-for feature at this stage.

## Rationale

Pydantic AI provides typed inputs and outputs via Pydantic models, eliminating per-route parsing code. Tool-calling becomes a unified pattern rather than an ad-hoc reimplementation. `run_stream_events()` yields typed events the frontend can render directly. Logfire attaches free traces across agents, tools, and LLM calls with no additional instrumentation code.

## Consequences

- (+) Typed inputs and outputs via Pydantic models — fewer parsing bugs.
- (+) Tool-calling unifies a pattern previously reimplemented in `learn.py` and `quiz.py`.
- (+) `run_stream_events()` gives typed events the frontend can render directly.
- (+) Logfire gives free traces across agents, tools, and LLM calls.
- (−) New dependency to keep current. Pydantic AI is moving fast (issue #2293 on thought-signature handling was open at time of writing).
- (−) Two paradigms coexist during migration. `gemini_service.py` is the legacy fallback until refactor #3 ships.
- (−) The Gemini free tier was removed as of December 2025 — billing must be enabled before agents go to production.
