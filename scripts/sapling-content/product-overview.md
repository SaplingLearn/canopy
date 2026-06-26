## What Sapling Is

**Sapling** is an AI-powered study companion built for college students. Its central idea is simple: as you learn — through tutoring sessions, quizzes, and uploaded notes — a **live knowledge graph** grows and updates in real time, mapping what you know and where gaps remain. Every interaction feeds mastery scores back into that graph, so your study state is never a flat checklist but a living picture of understanding.

The primary audience is students enrolled in courses at a specific institution (sign-in is gated by email domain, defaulting to `bu.edu`). A role system with an admin panel supports instructors and staff alongside students.

---

## Core Idea: Learn → Live Knowledge Graph

The knowledge graph is the spine of the product. Every concept you encounter — through a chat session, a quiz answer, an uploaded document, or a note — is extracted and merged into a per-user, per-course graph stored in Supabase. **Mastery scores update dynamically** after every session and quiz, and the graph drives:

- What the adaptive quiz targets next (weakest nodes)
- What the study guide pulls from when generating exam prep
- How classmates' progress compares to yours in study rooms
- What concepts a note is linked to, enabling note-grounded quizzes and chat

---

## Feature Set

### Knowledge Graph

- **2D view** — rendered with D3.js (SVG), the default. Per-course color shading and mastery-based node opacity.
- **3D view** — rendered via `react-force-graph-3d` (three.js / WebGL), lazy-loaded so it only enters the bundle when toggled on.
- Recommendations endpoint surfaces next concepts to study based on graph state.

### AI Tutor — Three Teaching Modes

All three modes run through a single `chat_tutor_agent` (Pydantic AI, `gemini-2.5-pro` by default):

| Mode | Behavior |
|---|---|
| **Socratic** | Guided reasoning — the tutor asks questions rather than explaining directly |
| **Expository** | Direct explanation of concepts |
| **TeachBack** | You explain; Sapling corrects misunderstandings |

Chat supports **inline math** (KaTeX), **Mermaid diagrams**, function plots, and theorem callouts.

### Adaptive Quizzes

AI-generated quizzes target your **weakest concepts** from the knowledge graph. Difficulty scales with performance, and spaced-repetition scheduling resurfaces concepts you've previously missed. Quiz generation runs through a dedicated `quiz_agent` (`gemini-2.5-flash-lite`).

### Flashcards

Generate AI flashcards per course, or import from multiple sources: paste, file (CSV, Markdown, Anki), URL, AI prompt, or photo. Study by topic with spaced-repetition ratings (**Easy / Hard / Forgot**). A multi-step import pipeline handles parse → cleanup → cloze conversion → commit.

### Gradebook

Track real-world grades per course. Supports:
- Custom categories with weights
- Per-assignment scores
- Per-course letter-scale overrides
- Current grade calculation

Upload a syllabus and Sapling auto-extracts categories and assignments via the `syllabus_extraction` agent (`gemini-2.5-flash`).

### Study Guide

Generates a Gemini-powered exam study guide from uploaded course materials. Guides are **cached per exam** and can be regenerated on demand via `POST /api/study-guide/regenerate`.

### Document Library

Upload PDFs and notes (up to 100 MB each). The ingest pipeline is an agentic parallel fan-out:

1. **Classifier agent** — determines document type
2. **Summary, concept-extraction, and syllabus agents** — run in parallel via `asyncio.gather`
3. Extracted concepts merge into the knowledge graph; summaries and concept notes are stored AES-256-GCM encrypted

The streaming upload endpoint (`POST /api/documents/upload`) uses **Server-Sent Events** (sse-starlette) to emit live per-phase progress to the UI: `status:start → progress:classify → progress:classified → progress:extract → progress:extracted → progress:graph_update → result:finalize → status:done`. Uploads are **idempotent** on `X-Request-ID`.

OCR uses **Docling** (layout-aware PDF → Markdown) with GOT-OCR 2.0 as a fallback for math and handwriting, and Tesseract retained as a legacy fallback.

### Notetaker

Write typed notes per course with debounced autosave and tags. Per note, four agent-backed actions are available:
- **AI summarize** — `note_summary_agent`
- **Extract concepts** — merges into the knowledge graph and links back to the note
- **Note-grounded chat** — ask questions about the note's content
- **Generate quiz** — targets the note's weakest linked concept

### Calendar & Syllabus Tracking

Paste a syllabus; Sapling extracts assignments, deadlines, and topics automatically. Upcoming assignments are accessible via `GET /api/calendar/upcoming/{user_id}`.

### Class Intelligence

Aggregates **anonymized class-wide patterns** to surface common misconceptions and weak areas, personalizing individual tutoring sessions.

### Study Rooms & Chat

- **Study Rooms** — invite classmates, compare knowledge graphs, and track relative mastery across the group. Includes an AI-generated group summary and a study-partner matching endpoint.
- **Room Chat** — real-time text chat with avatars inside each room (currently REST-polled after the RLS lockdown; a realtime JWT bridge is planned).

### Profiles, Achievements & Cosmetics

- **Public profiles** — academic info, bio, featured achievements, equipped cosmetics
- **Achievements** — unlocked by milestones (sessions, quizzes, streaks); admin-configurable with triggers
- **Cosmetics** — avatar frames, name colors, title flairs; equipped per user; linked to roles or achievements

### Roles & Admin Panel

Role-based access control. The admin panel covers: user approval/unapproval, role assignment, achievement management (including manual grants), cosmetic management, and a paginated audit log. Analytics overview provides 30-day series and role counts.

### Onboarding

Multi-step flow after first Google OAuth sign-in. Collects school, major, year, and courses. Sign-in itself is a popup-based Google OAuth flow launched from the landing page.

### Newsletter & Feedback

- **Newsletter** — beta-list email signup directly from the landing page (`POST /api/newsletter/subscribe`)
- **Feedback** — session feedback and bug/issue reports submittable from within the app

---

## How It Fits Together

```
Next.js 16 frontend  ──REST──►  FastAPI backend  ──►  Supabase (PostgreSQL)
(TypeScript, App Router)         (Python)               AES-256-GCM encrypted columns
(Cloudflare Workers via          Pydantic AI agents
 @opennextjs/cloudflare)         Google Gemini
                                 (per-task model routing)
```

- **Frontend** — Next.js 16 (TypeScript, App Router), deployed on Cloudflare Workers via `@opennextjs/cloudflare`. The knowledge graph 2D layer uses D3.js; the 3D layer (`react-force-graph-3d`) is lazy-loaded.
- **Backend** — FastAPI (Python) at `localhost:5000`. Agentic workloads use **Pydantic AI** with four parallel worker agents for document ingestion and dedicated agents for chat, quizzes, syllabus extraction, and the notetaker. Remaining LLM routes use a structured-prompt helper in `services/gemini_service.py` pending migration.
- **AI** — **Google Gemini**, with per-task model routing via `SAPLING_MODEL_<TASK>` env vars. `gemini-2.5-pro` powers the chat tutor; `gemini-2.5-flash` handles concept extraction, syllabus parsing, and note chat; `gemini-2.5-flash-lite` covers classification, summarization, quiz generation, and note summarization.
- **Database** — **Supabase** (PostgreSQL). Sensitive columns (user PII, document summaries, concept notes, OAuth tokens, chat messages, gradebook notes) are AES-256-GCM encrypted at the application layer via the `cryptography` library. Row-Level Security is enabled on all 40 public tables with the `anon` role's DML revoked.
- **Observability** — Logfire auto-instruments Pydantic AI agent runs, tool calls, and FastAPI requests. A custom scrubber (`backend/services/logfire_scrubber.py`) SHA-256-fingerprints prompt and output content before egress so raw user text never ships to the observability backend.
