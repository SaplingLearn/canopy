## FastAPI Application

The backend is a single FastAPI application (`backend/main.py`) run with Uvicorn on `PORT` (default 5000). Startup runs `validate_config()`, which fails loudly if `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, or `GEMINI_API_KEY` are absent, and if `SESSION_SECRET` is missing or shorter than 32 bytes outside of local dev. The lifespan also bootstraps the Supabase `avatars` storage bucket before the first request is served.

**Middleware stack (outermost to innermost):**
- `RequestIDMiddleware` — stamps every request with a UUID, tags every response with `X-Request-ID`, and emits one structured log line per request.
- `CORSMiddleware` — allows `FRONTEND_URL`, `localhost:3000`, and `saplinglearn.com`; additional origins via `CORS_ORIGINS` env var.
- `RecostMiddleware` (optional) — cost-tracking middleware; skipped if the `recost` package is not installed.

**Route prefixes:**

| Prefix | Module |
|---|---|
| `/api/auth` | `routes/auth.py` |
| `/api/documents` | `routes/documents.py` |
| `/api/learn` | `routes/learn.py` |
| `/api/quiz` | `routes/quiz.py` |
| `/api/graph` | `routes/graph.py` |
| `/api/extract` | `routes/extract.py` |
| `/api/notes` | `routes/notes.py` |
| `/api/flashcards` | `routes/flashcards.py` |
| `/api/study-guide` | `routes/study_guide.py` |
| `/api/calendar` | `routes/calendar.py` |
| `/api/gradebook` | `routes/gradebook.py` |
| `/api/profile` | `routes/profile.py` |
| `/api/admin` | `routes/admin.py` |
| `/api/social` | `routes/social.py` |
| `/api/careers` | `routes/careers.py` |
| `/api/onboarding` | `routes/onboarding.py` |
| `/api/newsletter` | `routes/newsletter.py` |
| `/api/feedback` | `routes/feedback.py` |
| `/api` (academics) | `routes/academics.py` |
| `/api/health` | inline — returns `{"status": "ok"}` |
| `/api/gemini-test` | inline — admin-only Gemini connectivity check |

All error handlers (`HTTPException`, `RequestValidationError`, unhandled exceptions) attach the `request_id` to the JSON body and the `X-Request-ID` response header.

**`backend/config.py`** centralises environment variables: `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`, `FRONTEND_URL`, `PORT`, `APP_ENV`, and `ALLOWED_EMAIL_DOMAINS` (default `bu.edu`). `validate_config()` checks required values at startup. A `get_mastery_tier(score)` helper maps float scores to `mastered / learning / struggling / unexplored`.

Observability is via Logfire (`logfire.instrument_pydantic_ai()`). A custom `scrub_value` callback in `services/logfire_scrubber.py` redacts prompt text and model output before egress so user-uploaded document content never leaves the process in trace attributes.

---

## Pydantic AI Agent System

Agents live in `backend/agents/` and use `pydantic-ai-slim[google]` (ADR 0001). Each agent is a typed `pydantic_ai.Agent` instance; inputs are plain strings or Pydantic models, outputs are validated Pydantic models. Shared runtime state is passed via `SaplingDeps` (defined in `agents/deps.py`):

```python
@dataclass
class SaplingDeps:
    user_id: str
    course_id: str | None
    supabase: Any        # Supabase client
    request_id: str      # correlation ID for Logfire spans
    session_id: str | None = None
```

### Worker agents

| Agent module | Output type | Purpose |
|---|---|---|
| `agents/classifier.py` | `DocumentClassification` | 7-way document type classifier; sets `is_syllabus` flag |
| `agents/summary.py` | `Summary` | Short prose summary of an uploaded document |
| `agents/concept_extraction.py` | `ConceptList` | Extracts Title-Case concept names for the knowledge graph |
| `agents/syllabus_extraction.py` | `SyllabusAssignments` | Parses assignments, due dates, grading weights from a syllabus |
| `agents/quiz.py` | `Quiz` | Generates structured multiple-choice questions; uses tools to pull weak concepts and recent attempt history |
| `agents/chat_tutor.py` | streaming text | Multi-turn pedagogical tutor in Socratic / Expository / TeachBack modes |
| `agents/note_summary.py` | `NoteSummary` | 2–4 sentence summary of a single student note |
| `agents/note_concepts.py` | `NoteConcepts` | Concept names extracted from a note for graph merge |
| `agents/note_chat.py` | streaming text | Sidecar chat scoped to one open note in the notetaker |

### Document ingestion pipeline (`agents/document.py`)

`process_document(text, deps)` is the orchestration entry point for uploaded documents. It is not an agent itself — it is a `@durable_workflow` function that coordinates the workers deterministically:

1. **Classify first** (`_step_classify`) — gates whether syllabus extraction runs.
2. **Fan out in parallel** (`asyncio.gather`) — summary + concept extraction, plus syllabus extraction if `is_syllabus` is true.
3. **Merge graph** — calls `apply_concepts_to_graph` directly (no orchestrator agent round-trip) with the already-extracted concept names.

Each `_step_*` function is wrapped with `@durable_step`. When `DBOS_ENABLED` is set (see ADR 0011), DBOS checkpoints each completed step so a crash mid-pipeline resumes from the last completed worker rather than from scratch. With `DBOS_ENABLED` unset (the default), both decorators are no-ops.

If `process_document` raises, `routes/documents.py` falls back to `_legacy_upload_pipeline` backed by `services/gemini_service.py`.

### Agent tools

Tools in `backend/agents/tools/` are shared across agents via Pydantic AI's `Tool` registration:

- `chat_context.py` — `read_session_history_tool`, `read_user_progress_tool`, `search_course_materials_tool`
- `graph.py` — `apply_graph_update_tool`, `apply_concepts_to_graph`
- `graph_read.py` — `read_concepts_for_user_tool`, `read_misconceptions_for_course_tool`
- `quiz_history.py` — `read_recent_quiz_attempts_tool`
- `note_context.py` — `read_active_note_tool`
- `syllabus_adapter.py` — syllabus-to-calendar adapter helpers

---

## Per-task Model Routing

Defined in `backend/agents/_providers.py` (ADR 0008). `model_for(task)` reads `SAPLING_MODEL_<TASK_UPPER>` from the environment first, falling back to the defaults below. Selection happens at module import (process start) — a restart is required for env-var changes to take effect.

| Task key | Default model | Rationale |
|---|---|---|
| `classifier` | `gemini-2.5-flash-lite` | 7-way classification; lite is sufficient |
| `summary` | `gemini-2.5-flash-lite` | Short-form prose; cost saving with no quality loss |
| `quiz` | `gemini-2.5-flash-lite` | Single-shot structured call; value is in tool wiring, not model strength |
| `note_summary` | `gemini-2.5-flash-lite` | Single-note summarisation |
| `note_concepts` | `gemini-2.5-flash-lite` | Concept extraction from a note |
| `concepts` | `gemini-2.5-flash` | Structured list output; benefits from full Flash |
| `syllabus` | `gemini-2.5-flash` | Date parsing and schema constraints need full Flash |
| `note_chat` | `gemini-2.5-flash` | Note-scoped sidecar chat |
| `chat_tutor` | `gemini-2.5-pro` | Multi-turn pedagogical reasoning; Pro quality drives perceived UX |

Override example: `SAPLING_MODEL_CLASSIFIER=gemini-2.5-pro`. The `google_model(name)` function is a back-compat shim for callers that need to bypass the selector and pin a specific model.

---

## Legacy Structured-Prompt Helper (`services/gemini_service.py`)

Routes not yet migrated to Pydantic AI call `services/gemini_service.py` directly via bare `google-genai` calls. Key functions:

- `call_gemini(prompt, retries, json_mode, model)` — single-turn call returning a string.
- `call_gemini_multiturn(system_prompt, history, user_message, retries, model)` — multi-turn call.
- `call_gemini_json(prompt, model)` — single-turn call with JSON extraction and backtick-fence stripping.
- `generate_flashcards(...)` — flashcard generation helper.

Defaults: `MODEL_DEFAULT = "gemini-2.5-flash"`, `MODEL_LITE = "gemini-2.5-flash-lite"`, `MODEL_SMART = "gemini-2.5-pro"`. This file remains as the fallback for `process_document` failures and as the implementation behind routes that predate the Pydantic AI migration (ADR 0001).

---

## Prompts (`backend/prompts/`)

Text prompt files consumed by agents and legacy routes:

| File | Used by |
|---|---|
| `preamble.txt` | Shared across tutor modes |
| `socratic.txt` | Chat tutor — Socratic mode |
| `expository.txt` | Chat tutor — Expository mode |
| `teachback.txt` | Chat tutor — TeachBack mode |
| `shared_context.txt` | Injected context block |
| `quiz_generation.txt` | Quiz agent |
| `quiz_context_update.txt` | Quiz context refresh |
| `syllabus_extraction.txt` | Syllabus agent |
| `study_match.txt` | Study-guide matching |
| `flashcard_generation.txt` | Flashcard generation |
| `flashcard_cleanup.txt` | Flashcard dedup/cleanup |
| `flashcard_cloze.txt` | Cloze flashcard variant |
| `flashcard_ocr_split.txt` | OCR flashcard splitting |

The `refactor-3-chat-tutor/` and `refactor-4-syllabus-unification/` subdirectories hold prompt revisions that landed with those named refactors.
