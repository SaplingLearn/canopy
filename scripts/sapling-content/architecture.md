## System overview

Sapling is a two-process system: a **Next.js 16 frontend** (TypeScript, App Router) deployed to Cloudflare Workers via `@opennextjs/cloudflare`, and a **FastAPI backend** (Python) running on port 5000. The two communicate exclusively over REST + SSE — there is no GraphQL layer, no WebSocket, and no shared process. Supabase (PostgreSQL via PostgREST) is the sole datastore; Google Gemini is the sole LLM provider.

```
Browser
  │  REST (JSON) + SSE (multipart POST)
  ▼
Next.js 16 (App Router, CF Workers)
  │  NEXT_PUBLIC_API_URL → http(s)://backend:5000
  ▼
FastAPI  (/api/<router>)
  ├── Supabase PostgREST  (all CRUD via db/connection.py::table())
  ├── Google Gemini       (via services/gemini_service.py + agents/)
  └── Supabase Storage    (avatar / cosmetic uploads)
```

## Frontend

**Runtime:** Next.js 16, App Router, TypeScript. Deployed as a Cloudflare Worker (OpenNext adapter; `frontend/wrangler.toml`).

**Route layout** (`frontend/src/app/`):

| Route | Description |
|---|---|
| `/` | Landing page with newsletter + Google OAuth popup |
| `/(shell)/` | Authenticated shell layout (sidebar, top nav) |
| `/onboarding` | Multi-step profile + course selection |
| `/flashcards` | Flashcard study + import |
| `/about`, `/careers`, `/privacy`, `/terms` | Public static pages |

All authenticated screens live inside the `(shell)` route group. Components are colocated under `frontend/src/components/`, with screen-level components in `components/screens/` (Dashboard, Calendar, Admin, Achievements, etc.).

**API calls** go through a typed client in `frontend/src/lib/api.ts`, which prepends `NEXT_PUBLIC_API_URL`. Auth state is an HMAC session token stored in a cookie; `SESSION_SECRET` in both the frontend and backend must match for middleware token verification.

**Knowledge graph rendering** is handled by a two-implementation wrapper at `components/KnowledgeGraph.tsx`:

- **2D (default):** `KnowledgeGraph2D.tsx` — D3 force-directed graph drawn to an SVG. Nodes are colored by course and shaded by mastery score.
- **3D (lazy):** `KnowledgeGraph3D.tsx` — `react-force-graph-3d` (three.js / WebGL). Imported via `next/dynamic` with `ssr: false` so the three.js bundle is excluded from the initial payload and only fetched when the user toggles to 3D mode. The chosen mode is persisted in `localStorage` under `sapling.kg.mode` and synchronized across mounted instances via a custom DOM event.

**Chat rendering:** `MarkdownChat.tsx` renders assistant replies with KaTeX (inline math), Mermaid (diagrams), and `FunctionPlot.tsx` (function plots). Teaching-mode callouts (Socratic, Expository, TeachBack) are styled via the same component.

**SSE consumer:** `frontend/src/lib/sse.ts` reads the backend's streaming upload response from a `fetch` `ReadableStream` rather than the native `EventSource` API, because `EventSource` cannot send `multipart/form-data` POST bodies.

## Backend

**Entry point:** `backend/main.py` creates a single `FastAPI` app (`title="Sapling API"`, `version="1.0.0"`), configures Logfire instrumentation, CORS, a `RequestIDMiddleware` (correlation ID on every request), and optional `RecostMiddleware` (per-call LLM cost tracking). On startup the lifespan hook calls `validate_config()` (hard-fail on missing secrets) and `ensure_bucket_exists()` (idempotent Supabase Storage bootstrap).

**Router layout** (`backend/routes/`):

| Module | Prefix |
|---|---|
| `learn.py` | `/api/learn` |
| `graph.py` | `/api/graph` |
| `quiz.py` | `/api/quiz` |
| `flashcards.py` | `/api/flashcards` |
| `gradebook.py` | `/api/gradebook` |
| `study_guide.py` | `/api/study-guide` |
| `calendar.py` | `/api/calendar` |
| `documents.py` | `/api/documents` |
| `notes.py` | `/api/notes` |
| `social.py` | `/api/social` |
| `auth.py` | `/api/auth` |
| `onboarding.py` | `/api/onboarding` |
| `profile.py` | `/api/profile` |
| `admin.py` | `/api/admin` |
| `academics.py`, `extract.py`, `careers.py`, `feedback.py`, `newsletter.py` | `/api/<name>` |

**Services layer** (`backend/services/`): `gemini_service.py` (legacy LLM helper), `graph_service.py` (`apply_graph_update`, `apply_concepts_to_graph`), `course_context_service.py` (aggregated class misconceptions + weak-area stats), `extraction_service.py` (Docling/GOT-OCR/Tesseract text extraction), `encryption.py` (AES-256-GCM column-level encryption for PII, messages, tokens, gradebook notes), `calendar_service.py`, `gradebook_service.py`, `notes_service.py`, `matching_service.py`, `profiles.py`, `academics.py`.

**Data access:** All runtime reads and writes go through `backend/db/connection.py::table()`, which wraps Supabase PostgREST with `httpx`. There is no ORM. DDL is delivered as ordered SQL migrations (`backend/db/migrations/0001`–`0028`) applied by `backend/db/migrate.py` over a direct `psycopg` connection — the sole exception to the PostgREST-only rule.

**Prompt templates** (`backend/prompts/`): `.txt` files for quiz generation, quiz context update, syllabus extraction, flashcard generation/cleanup/cloze, the three teaching-mode system prompts (`socratic.txt`, `expository.txt`, `teachback.txt`), and `shared_context.txt` / `preamble.txt`. Agents inline their own system prompts per ADR 0003; these `.txt` files serve the legacy `gemini_service` call sites and specialized routes.

## Agentic document-ingestion pipeline

`POST /api/documents/upload` is the most complex request path. It runs a **4-agent pipeline** defined in `backend/agents/document.py` and streams live progress back to the browser via SSE.

**Concurrency model:**

```
upload_document (route)
  │
  ├─ extraction_service.extract_text_from_file()   ← OCR/Docling
  │
  └─ process_document()  @durable_workflow
       │
       ├─ _step_classify()   classifier_agent     ← runs first (gates syllabus branch)
       │
       └─ asyncio.gather(
            _step_summary()   summary_agent,
            _step_concepts()  concept_extraction_agent,
            _step_syllabus()  syllabus_extraction_agent  ← only if is_syllabus=True
          )
       │
       └─ apply_concepts_to_graph()  ← deterministic graph merge, no agent
```

All four workers are Pydantic AI agents (`pydantic-ai-slim[google]`) with typed Pydantic output models (`DocumentClassification`, `Summary`, `ConceptList`, `SyllabusAssignments`). Each `_step_*` function is decorated with `@durable_step` from `services/durable.py`; when `DBOS_ENABLED=true` and the optional `dbos` package is present, the workflow gains per-step crash-resume checkpointing. By default, the decorator is a no-op passthrough.

**SSE event sequence** emitted to the client:

```
status:start → progress:classify → progress:classified
  → progress:extract → progress:extracted
  → progress:graph_update → progress:graph_updated
  → result:finalize → status:done
```

On agent failure, the route catches the exception and falls back to `_legacy_upload_pipeline` (a single `call_gemini_json` call), emitting `error:fallback` before continuing. A terminal failure emits `error:failed`. Uploads are idempotent on `X-Request-ID`.

**Model routing:** Each agent's model is individually configurable via `SAPLING_MODEL_<TASK>` env vars. Defaults: `gemini-2.5-flash-lite` for classifier, summary, quiz, and note summary/concepts; `gemini-2.5-flash` for concept extraction, syllabus, and note chat; `gemini-2.5-pro` for the chat tutor. Model slots are resolved in `agents/_providers.py`.

## LLM migration state

The codebase is mid-migration from a monolithic `gemini_service.py` helper toward discrete Pydantic AI agents. Agents already own: document ingestion (4 workers), quiz generation (`agents/quiz.py`, with `gemini_service` fallback), chat tutor (`agents/chat_tutor.py`), syllabus extraction (`agents/syllabus_extraction.py`), and all three notetaker actions (`agents/note_summary.py`, `agents/note_concepts.py`, `agents/note_chat.py`). Routes still on the legacy helper: study guide, flashcard generation, social matching, and parts of the document route that haven't been cut over. The legacy helper exposes four entry points: `call_gemini` (plain text), `call_gemini_multiturn` (native chat history), `call_gemini_json` (JSON-mode with tolerant `_extract_json` fallback), and `extract_graph_update` (parses `<graph_update>` XML blocks out of tutor replies).
