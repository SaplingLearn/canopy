## Upload endpoint

Documents enter the pipeline through `POST /api/documents/upload` (streaming) or `POST /api/documents/upload/sync` (non-streaming JSON). Both accept multipart form data with three fields: `file` (the binary payload), `course_id`, and `user_id`. Accepted formats are **PDF, DOCX, and PPTX** up to **100 MB**. The route validates the file extension and content-type before reading the body; oversized or unsupported files receive a `400` before the SSE stream opens.

Every upload is stamped with the `X-Request-ID` header value (set by FastAPI middleware). If a retry arrives with the same ID, the route short-circuits: it looks up the previously persisted `documents` row and returns it without re-running the pipeline. This makes the streaming endpoint safe to retry on network loss without double-processing.

---

## OCR and text extraction

Text extraction is handled by `backend/services/extraction_service.py`. The strategy depends on the `OCR_ENGINE` environment variable (default `"docling"`):

**PDFs** go through a two-tier path:
1. `pypdf` native extraction is attempted first. If it returns 50+ characters, the result is used directly (fast path for digitally-produced PDFs).
2. If native extraction yields too little text, `extract_text_from_pdf_ocr` is called. This invokes **Docling** (`extraction_backends/docling_backend.py`), a layout-aware converter that produces structured Markdown preserving headings, tables, and reading order.
3. When `OCR_ENGINE=auto` and `GOT_OCR_ENABLED=true`, pages that Docling marks as low-confidence (`fallback_pages` in the returned metadata) are re-processed with **GOT-OCR 2.0** (`extraction_backends/got_ocr_backend.py`), which handles handwritten text and mathematical notation. Each flagged page is rendered to a PNG via `pypdfium2` at 2× scale and passed to the GOT-OCR model with `ocr_type="format"`.
4. If Docling is unavailable (raises `DoclingUnavailableError`) or fails, extraction falls back to **Tesseract** (`extraction_backends/tesseract_backend.py`) as the legacy path.

**DOCX and PPTX** always go through the Tesseract backend's `python-docx` / `python-pptx` parsers, which extract raw text without OCR.

---

## Async OCR (feature flag)

By default, `extract_text_from_file` runs synchronously before the SSE stream opens, meaning the user sees no events during OCR. When **`OCR_ASYNC_ENABLED=true`**, the route defers extraction into the stream:

1. The `EventSourceResponse` opens immediately.
2. The stream emits `progress:extracting_text` ("Extracting text from document...").
3. `asyncio.to_thread(extract_text_from_file, ...)` runs OCR off the event loop.
4. On success, the stream emits `progress:extracted_text` with the character count and continues to the agent pipeline.
5. On failure, a terminal `error:failed` event followed by `status:done` ("Failed.") closes the stream.

This delivers the primary UX benefit of ADR 0010 — no blank spinner during OCR — without requiring a separate worker tier or queue. The full two-phase design (separate `POST /upload` returning HTTP 202 + `GET /upload/<id>/events`) is deferred; see ADR 0010 for the trigger conditions.

---

## Four parallel worker agents

After text is extracted, the pipeline runs four **Pydantic AI** agents:

| Agent | Model (default) | Output |
|---|---|---|
| `classifier_agent` | `gemini-2.5-flash-lite` | Document category + `is_syllabus` flag |
| `summary_agent` | `gemini-2.5-flash-lite` | Abstract (2–3 sentence summary) |
| `concept_extraction_agent` | `gemini-2.5-flash` | `ConceptList` — ordered by importance, `{name, description}` pairs |
| `syllabus_extraction_agent` | `gemini-2.5-flash` | Assignments, due dates, grading categories (syllabus only) |

The classifier runs first (serial gate). Its output determines which workers fire: **summary and concept extraction always run**; the syllabus agent fires only when `is_syllabus=true`. The applicable workers are launched with `asyncio.gather`, so they execute concurrently. Each agent receives a `SaplingDeps` context (user, course, request ID) and a `WORKER_LIMITS` usage cap.

After the workers complete, `apply_concepts_to_graph` merges extracted concept names into the user's knowledge graph for the course.

All extracted text, summaries, and concept notes are **AES-256-GCM encrypted** before being written to Supabase (`services/encryption.py`).

---

## SSE streaming events

The streaming upload route wraps the entire pipeline in an `EventSourceResponse` (via `sse-starlette`). A custom `SaplingEvent` Pydantic model and `sapling_event_to_sse` mapper in `backend/services/agent_events.py` produce the wire format. Events are typed by `(type, step)`:

| Wire event | Meaning |
|---|---|
| `status:start` | Stream opened, file received |
| `progress:extracting_text` | OCR started (async mode only) |
| `progress:extracted_text` | OCR complete, char count in message |
| `progress:classify` | Classifier agent running |
| `progress:classified` | Category and `is_syllabus` in `data` |
| `progress:extract` | Worker agents starting |
| `progress:extracted` | Workers done, concept count in message |
| `progress:graph_update` | Graph merge starting |
| `progress:graph_updated` | N concepts merged |
| `result:finalize` | Full `DocumentProcessingResult` in `data` |
| `status:done` | `document_id` in `data`; stream closes |
| `error:fallback` | Agent guardrails tripped; falling back to legacy single-call pipeline |
| `error:failed` | Terminal failure |

If the Pydantic AI agents trip a usage limit or behave unexpectedly, an `error:fallback` event is emitted and the route drops to `_legacy_upload_pipeline` — a single `call_gemini_json` call that returns the same shape. If the legacy path also fails, a terminal `error:failed` event and `status:done` close the stream cleanly.

---

## Frontend SSE consumer

The browser's built-in `EventSource` only supports GET requests and cannot send a multipart body. The frontend uses a custom async generator in **`frontend/src/lib/sse.ts`** instead.

`streamSSE(url, init)` calls `fetch` with the provided `RequestInit` (which carries the multipart form body and auth cookie), then reads `response.body` as a `ReadableStream<Uint8Array>`. It manually implements the [SSE wire format](https://html.spec.whatwg.org/multipage/server-sent-events.html): blocks separated by blank lines (`\n\n` or `\r\n\r\n`), `event:` and `data:` fields parsed per spec, multiple `data:` lines joined with `\n`. The `data` value is always parsed as JSON (backend payloads are guaranteed JSON); on parse failure the raw string is yielded.

```typescript
for await (const { event, data } of streamSSE<UploadEvent>('/api/documents/upload', { method: 'POST', body: formData })) {
  // event: "progress:classified" | "result:finalize" | "status:done" | ...
}
```

The generator completes when the server closes the connection (reader returns `done: true`). A `finally` block cancels and releases the reader lock on any early exit. Nine Vitest tests in `frontend/src/lib/sse.test.ts` cover the parser against real SSE byte sequences.

---

## Re-scan endpoints

Two endpoints allow concept graphs to be refreshed without re-uploading:

- **`POST /api/documents/doc/{doc_id}/scan-concepts`** — Decrypts the stored summary and concept notes for a single document, then calls `_extend_course_concepts` (a focused `gemini-2.5-flash-lite` prompt) to discover new concepts not yet in the graph and writes them via `apply_graph_update`.
- **`POST /api/documents/course/{course_id}/scan-concepts`** — Same scan logic, but seeded only from the course label and whatever concepts already exist in the graph.

Both routes check existing graph nodes before calling the LLM, so the model only generates net-new concepts and the graph never receives duplicates.

---

## Concept-by-concept streaming (deferred)

ADR 0012 proposes streaming individual concept names as they materialize from the model via `concept_extraction_agent.run_stream()`, emitting `progress:concept` events per name rather than one `progress:extracted` after the full list arrives. This design is deferred pending empirical data on whether Gemini emits concepts in importance order (the schema requires importance-descending). Concept extraction also currently runs inside `asyncio.gather` alongside summary extraction; extracting it into a streaming branch would require either serializing the gather or running a hybrid concurrent-plus-streaming pattern. See ADR 0012 for the implementation sketch and the conditions under which it should be revisited.
