## Live Knowledge Graph

Every user's understanding is represented as a directed graph stored in two Supabase tables — `graph_nodes` and `graph_edges` — and served via `GET /api/graph/{user_id}`. Each node corresponds to a single concept and carries a `mastery_score` (0.0–1.0), a `mastery_tier` (`mastered` / `learning` / `struggling` / `unexplored`), a `last_studied_at` timestamp, and a `course_id` that pins it to an enrolled course. Edges carry a `strength` float and a `relationship_type`. Mastery updates are recorded as append-only rows in `node_mastery_events` (added in migration `0023`), which the backend aggregates into a velocity metric (mastery gained per day over the last 14 days).

### 2D and 3D views

The frontend renders the graph in two modes, toggled by a button that persists the choice in `localStorage` under the key `sapling.kg.mode` and syncs across mounted instances via a `storage` event plus a same-tab custom event (`sapling:kg-mode-change`).

- **2D (default)** — `KnowledgeGraph2D.tsx` uses a live `d3-force` simulation with `forceLink`, `forceManyBody`, `forceCollide`, and `forceCenter`. Nodes are SVG circles; pan and zoom are handled via pointer capture and a wheel handler. The simulation pauses automatically when the SVG scrolls off-screen via `IntersectionObserver`. Subject-root nodes (one per enrolled course) are larger (radius 22 vs. 8–20) and labeled; concept nodes display their name when their radius exceeds 10px. `prefers-reduced-motion` is respected — the simulation fast-forwards 200 ticks and stops instead of animating.
- **3D (WebGL)** — `KnowledgeGraph3D.tsx` uses `react-force-graph-3d` (three.js under the hood), lazy-loaded via Next.js `dynamic(..., { ssr: false })` so the three.js + `d3-force-3d` stack only enters the bundle as a client chunk when the user actually toggles 3D mode. Without the lazy load the OpenNext Cloudflare Worker bundle would exceed Cloudflare's size limit.

### Per-course color and mastery opacity

Each enrollment carries a `color` hex chosen at enrollment time. In `KnowledgeGraph2D`, a `shadeFor(baseHex, nodeId)` function derives a per-node HSL shade from the course color by seeding a deterministic hue/saturation/lightness offset from the node's id (using a shared `hashSeed` helper to avoid `Math.abs` overflow). Subject-root nodes render in the raw course color; concept nodes get their own shade within the course's hue family. Opacity encodes tier: `mastered` = 1.0, `learning` = 0.78, `struggling` = 0.55, `unexplored` = 0.28. Node radius scales with mastery score (8 + score × 12 pixels).

Study Rooms can overlay a partner's graph as a dashed comparison ring — `KnowledgeGraph2D` accepts an optional `comparison` prop (an array of `{name, mastery_score, partner_name}` entries matched by concept name) and renders a colored dashed circle around each matched node whose radius scales with the partner's mastery.

---

## Three Teaching Modes and the Chat Tutor

`routes/learn.py` dispatches chat messages to a Pydantic AI agent (`chat_tutor_agent`) selected by mode. Three agents are instantiated at module load from a shared preamble plus per-mode body (ADR 0015):

- **Socratic** — guides the student through reasoning with questions; prompts are versioned at hash `57f278a01d2d`. The eval case `SocraticEndsWithQuestionEvaluator` asserts that Socratic responses end with a question.
- **Expository** — explains topics directly with structure; hash `8c840f43b6e2`. `ExpositoryHasStructureEvaluator` checks for organized output.
- **TeachBack** — the student explains a concept and the tutor listens, corrects, and probes; hash `70a34fb09224`. `TeachBackProbesEvaluator` verifies follow-up questions.

The tutor agent has four tools: `search_course_materials_tool` (keyword overlap on `documents.summary` and `concept_notes`), `read_session_history_tool` (decrypts `messages.content` at the boundary), `read_user_progress_tool` (aggregates `graph_nodes` to mastered/weak/in-progress counts), and `apply_graph_update_tool` (writes mastery changes back to the graph). The default model is `gemini-2.5-pro`, overridable via `SAPLING_MODEL_CHAT_TUTOR`. A `model_pref` field on the chat request body (`"fast"` | `"smart"`) also influences model selection.

### Chat rendering

The `MarkdownChat` component (`frontend/src/components/MarkdownChat.tsx`) renders tutor responses as rich Markdown using `react-markdown` with the following pipeline:

- **remark-math + rehype-katex** — renders inline and block LaTeX. KaTeX macros include Castel-style shortcuts (`\R → \mathbb{R}`, `\norm`, `\abs`, `\inner`, `\Var`, `\Cov`, `\Tr`, `\diag`, `\eps`, etc.) plus the `mhchem` extension for chemistry notation.
- **remark-directive + custom plugin** — `:::theorem`, `:::definition`, `:::proof`, `:::lemma`, `:::corollary`, `:::proposition`, `:::example`, `:::remark`, `:::note`, `:::tip`, `:::warning` directives render as styled callout boxes. Proof blocks use a dashed border; warning blocks use a warning color.
- **Mermaid diagrams** — fenced code blocks tagged `mermaid` are extracted before syntax highlighting by a custom `rehypeExtractDiagramBlocks` plugin and handed to the `MermaidBlock` component.
- **Function plots** — fenced blocks tagged `plot` or `function-plot` are extracted the same way and rendered by `FunctionPlot`.
- **GeoGebra embeds** — `::geogebra{id=...}` leaf directives become lazy-loaded iframes pointing to `geogebra.org`.

---

## Adaptive Quizzes

Quiz generation runs through `backend/agents/quiz.py`, a Pydantic AI agent backed by Google Gemini (ADRs 0005, 0013, 0014). The agent's output schema is `Quiz { questions: list[QuizQuestion] }` with `QuizQuestion` carrying `question`, `type` (always `multiple_choice`), `difficulty` (`easy` / `medium` / `hard`), `options` (3–6 items), `correct_answer`, `explanation`, and `concept`.

The agent follows a three-tool workflow on each generation:

1. **`read_concepts_for_user`** — fetches the student's `graph_nodes` sorted by `mastery_score` ascending (weakest first). Each row includes `last_reviewed_at` for spaced repetition weighting.
2. **`read_misconceptions_for_course`** — reads the `class_analytics` table for the course offering, returning aggregated `common_misconceptions` strings observed across all students in that class.
3. **`read_recent_quiz_attempts`** — returns `QuizHistory { summary, recent_attempts }` for the target concept: a rolling digest from `quiz_context_service` plus the last five completed `quiz_attempts` rows (newest first, `completed_at IS NOT NULL` to exclude in-flight rows), with per-attempt `accuracy = score/total` precomputed.

From these signals the agent applies three adaptive rules: **weakest-first concept selection**, **spaced repetition** (concepts with `last_reviewed_at` older than ~7 days are treated as stale and boosted in priority), and **adaptive difficulty** (the difficulty mix shifts up or down by at most one step based on `recent_attempts.accuracy`, so the agent can never override the user's requested difficulty by more than one tier). Difficulty scaling is bounded to prevent overshooting.

The `QuizPanel` UI (`frontend/src/components/QuizPanel.tsx`) walks through four phases — `select` → `active` → `review` → `results`. After submission the backend scores each answer by looking up `options[i].correct`, updates the concept's mastery score via `apply_graph_update_tool`, and returns `{ score, total, mastery_before, mastery_after }` so the results screen can show the mastery delta.

---

## Flashcards

Flashcards are stored per-user and optionally per-topic in Supabase. The import surface (`FlashcardImportModal`) offers five tabs, each backed by a dedicated backend endpoint:

- **Paste** — raw text parsed client-side via `flashcardParsers.ts`, supporting CSV, pipe-delimited, and `Q: / A:` formats.
- **Upload** — file upload (CSV, Markdown, Anki `.apkg`).
- **URL** — `POST /api/flashcards/import/parse` fetches and parses content from a URL.
- **AI** — `POST /api/flashcards/import/generate` sends a topic string to Gemini and returns generated front/back pairs.
- **Photo** — image capture or upload processed through the OCR pipeline.

After preview and optional cleanup (`POST /api/flashcards/import/cleanup` and `/cloze` for cloze-deletion conversion), cards commit via `POST /api/flashcards/import/commit`. During study, `POST /api/flashcards/rate` accepts a rating of **1 (Forgot)**, **2 (Hard)**, or **3 (Easy)**, which feeds the spaced-repetition scheduler. Cards are filterable by topic. AI-generated flashcards are tied to the user's course graph.

---

## Notetaker

The notetaker (`/notetaker`) is a per-course typed notes surface backed by `routes/notes.py` (ADR 0017). Notes are stored in an encrypted `notes` table — `title`, `body`, `tags text[]`, and `last_summary` are all AES-256-GCM encrypted at the application layer; `tags` is kept plaintext so PostgREST array filters work.

**Autosave** is debounced at 800ms on title, body, and tags changes via `PATCH /api/notes/{note_id}`.

Each note supports four agent-backed actions, each a separate POST endpoint:

- **Summarize** (`/summarize`) — `note_summary` agent (flash-lite, output `NoteSummary { summary: str }`) generates and stores a summary in `notes.last_summary`.
- **Extract concepts** (`/extract-concepts`) — `note_concepts` agent (flash-lite, output `NoteConcepts { concepts: list[str] }`) extracts concept strings, merges them into the user's knowledge graph, and links them back to the note via the `note_concepts` junction table.
- **Note-grounded chat** (`/chat`) — `note_chat` agent (flash, freeform `str` output) has access to a `read_active_note` tool that reads the current note, plus `search_course_materials` and `apply_graph_update_tool`. The active note's id rides on `SaplingDeps.session_id` so the LLM never chooses which note to read.
- **Send to tutor** (`/send-to-tutor`) — builds a `{ topic, preface }` handoff from the note and pushes the browser to `/learn?topic=...&course=...`.
- **Generate quiz** (`/generate-quiz`) — selects the lowest-mastery linked concept and returns `{ concept_node_id, concept_name }`; the frontend then calls `/api/quiz/generate` separately, keeping quiz state in the quiz client.

Concept links are managed independently via `/api/notes/{note_id}/concepts` CRUD routes, with a `ConceptPickerModal` querying `getGraph` filtered to the active course.

---

## Study Guide Generation

`GET /api/study-guide/{user_id}/guide` fetches or generates a Gemini-powered exam study guide from the user's uploaded course documents. Guides are keyed by exam (an assignment of type exam from the gradebook) and cached per exam; `POST /api/study-guide/regenerate` invalidates the cache. The Study screen (`frontend/src/components/screens/Study.tsx`) renders guide content through `MarkdownChat` so math, diagrams, and callouts work identically to the chat tutor.

---

## Class Intelligence

The quiz agent's `read_misconceptions_for_course` tool reads a `class_analytics` table keyed by `offering_id` (the course section). Each row represents a concept and carries a `common_misconceptions` string array aggregated across all students enrolled in that offering — the individual student is never identified. The quiz agent uses these strings to write distractor options and quiz questions that address known class-wide weak areas rather than only the individual student's graph. The same misconception data is also injected into the legacy quiz path's prompt template at `routes/quiz.py` as a fallback.
