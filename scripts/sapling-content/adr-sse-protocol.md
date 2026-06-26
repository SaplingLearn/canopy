## Context

The document upload re-architecture research plan (PR #67) recommended using `pydantic_ai.ui.vercel_ai.VercelAIAdapter.dispatch_request(request, agent=agent)` for streaming. This was the path of least resistance: Pydantic AI ships an adapter that emits Vercel AI's wire protocol, the React frontend could use Vercel's `useChat`-style hooks directly, and there would be no custom wire format to maintain.

Sapling deviated. Streaming runs through `sse-starlette`'s `EventSourceResponse` plus a custom `SaplingEvent` schema and a `map_to_sapling_event(event)` function in `backend/services/agent_events.py`. That mapper translates Pydantic AI's internal event types by class name (not by import). The frontend consumes the stream via a custom `streamSSE` async generator in `frontend/src/lib/sse.ts`.

## Decision

Keep the custom SSE path. Do not adopt `VercelAIAdapter`.

## Rationale

The primary motivation is stability against upstream churn. The mapper dispatches by `type(event).__name__`, so a Pydantic AI class rename (e.g. `FunctionToolCallEvent` → `ToolCallEvent`) does not break the wire format — only the mapper needs updating. The frontend is not coupled to Vercel AI's protocol or hooks, which means the agent framework can be swapped or supplemented with non-agent event sources (such as the legacy fallback pipeline) without rewriting the React consumer.

The custom `streamSSE` helper is 90 lines, is reusable for future SSE endpoints (the chat tutor stream in refactor #4), and has 9 Vitest tests covering it. The upload UX is a one-shot stream rather than a multi-turn chat, so importing Vercel AI's `useChat` abstractions would bring in 80% unused surface area.

## Consequences

- (+) Stable Sapling-domain events (`progress:classify`, `progress:classified`, `progress:graph_update`, `result:finalize`, `status:done`) survive Pydantic AI version churn.
- (+) The frontend is decoupled from Vercel AI's protocol and hooks; the agent framework can be replaced without rewriting the React consumer.
- (+) `streamSSE` is a generic reusable helper for future SSE endpoints.
- (−) The wire format is hand-rolled. Bugs such as the `\r\n\r\n` separator mismatch (caught and fixed in commit `b6f395e`) would not have occurred with the adapter.
- (−) Vercel AI's `useChat` integration is unavailable; `uploadDocumentStream` was written from scratch.
- (−) When the chat tutor (refactor #4) is built, its streaming must reuse this seam rather than getting Vercel's chat abstractions for free.
