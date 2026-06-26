## Context

PR #67 originally landed with a `document_agent` that wrapped the graph-update step in an LLM-driven agent. The upload route called `document_agent.run_stream_events(...)`; the agent had one tool (`apply_graph_update_tool`); the tool merged extracted concept names into the user's course graph.

In practice the agent had zero decisions to make. By the time it ran, classification, summary, concept extraction, and (when applicable) syllabus parsing had all completed. Concept names were already extracted and validated. The orchestrator's only job was "call this one tool with these arguments." The project was paying for a Gemini Pro round-trip (~1–2 seconds plus Pro-tier tokens) to invoke a deterministic function.

The agent loop is justified when (a) the LLM must choose which tools to call, (b) the LLM iterates with intermediate tool results, or (c) retry-on-validation is needed. None of those conditions applied to the graph-update step.

## Decision

Drop `document_agent` and `GraphUpdateConfirmation`. Replace the agent loop in both upload routes with a direct call to a new async function `apply_concepts_to_graph(user_id, course_id, concept_names) -> int` in `backend/agents/tools/graph.py`. The Pydantic AI tool wrapper (`apply_graph_update_tool`) is retained so future agents that legitimately need a graph-update tool surface can register it.

The streaming `/upload` route emits two new SSE events around the direct call — `progress:graph_update` and `progress:graph_updated` — so the user's progress experience is unchanged.

## Rationale

The orchestrator added latency and cost without adding intelligence. Removing it makes the pipeline faster, cheaper, and easier to reason about. "Agent" in `backend/agents/` now has a clear meaning: a component that produces a typed output from unstructured text, where the LLM has a real decision to make. The graph-update step is a deterministic merge, not a decision.

## Consequences

- (+) One fewer Gemini call per upload — saves ~1–2 seconds wall-clock and the Gemini Pro tokens.
- (+) One fewer failure surface. `UsageLimitExceeded` and `UnexpectedModelBehavior` no longer apply to a step that never had a real loop.
- (+) Cleaner mental model: "agent" means "produces a typed output from text," not "wrapper around a single function call."
- (+) `apply_concepts_to_graph` is callable from anywhere — background workers, the legacy fallback — not only from agent contexts.
- (−) If a future need arises to make graph-update logic LLM-driven (e.g. decide which concepts to merge based on existing graph state), an agent of the same shape would need to be reintroduced. The tool wrapper stays in place to make that reintroduction trivial.
- (−) The "agentic upload" framing is now slightly less accurate: the worker phases are agents; the merge step is not. The pipeline is still typed, parallel, and observable — it is simply honest about which steps need an LLM.

## Rule going forward

If an agent's job is "call this tool with these arguments and return," it is not an agent. Use a direct function call. Reserve agent loops for steps where the LLM has a real decision to make.
