# Doc images — design

Status: implemented on `feat/doc-images` (2026-09-24). Decisions taken with the owner in conversation.

## Goal

Docs can contain images (screenshots, diagrams, charts), and an agent working in Claude Code can upload
one and reference it in a doc it proposes, the same way it proposes text. Canopy's rules hold: an agent's
image reaches a live doc only after a person promotes the proposal in Review, Review shows the image, and
a promoted doc version never changes after the fact.

**Scope (decided):** agents upload, people see. A web upload (paste / drag-drop in New doc) is deferred.

## Approach (decided: A)

Doc images are their own small, immutable, content-addressed store, not artifacts. Rejected: reusing
image artifacts (clutters the Artifacts library; an artifact can be private or re-versioned, leaving a
broken or changed image in a doc) and inline `data:` URIs (D1 row limits, noisy diffs and search).

**One upload tool (decided):** instead of a second tool, `artifact_create` is renamed **`upload_asset`**
and takes `destination: "artifact" | "doc"`. No alias: there is one tool.

## Storage

- `0031_doc_images`: `doc_images(sha256 PK, content_type, size_bytes, uploaded_by, created_at)` — png /
  jpeg / gif / webp, ≤ 10 MB — and `doc_image_upload_tokens` (the artifact tokens' twin, bound to
  principal + sha256 + size + type instead of a page; the artifact table requires a page and SQLite cannot
  relax that column without a rebuild).
- Bytes in R2 `ARTIFACTS_BUCKET` at `doc-images/<sha256>`: no new binding, no new deploy step.
- Immutable, never deleted; no garbage collection in this cut.

## Upload flow

1. `upload_asset { destination: "doc", sha256, size_bytes, content_type }` (`kind` optional, always
   `image`; page fields refused). Already stored → `{ ref, markdown, sha256, uploaded: true }`, nothing to
   PUT. Otherwise also `{ upload_url, expires_at }`.
2. `PUT <upload_url>` — the SAME route as artifacts, `/api/artifacts/upload/<token>`, dispatched before
   the session gate (the token is the auth). The handler tries the doc-image token table first. Single
   use, 5 minutes, streamed through `FixedLengthStream` into R2 with R2's own sha256 check; a mismatch is
   400 and releases the claim for a retry; used / expired is 410.
3. The agent writes `![what it shows](/img/<sha256>)` and proposes the doc.

## The gate

`docImageProblems` runs first in `ingestDocProposal`, so it covers `propose_doc_update`,
`record_session`, `/ingest`, triage assign and the web's New doc:

- every `/img/<sha>` must have a `doc_images` row;
- any other image source — external URL, `data:` URI, any other path — is refused (a third party would
  load into every reader's browser, and the image could change after promotion);
- image syntax inside fenced blocks and inline code is not scanned (a doc may explain image syntax);
- markdown images, `<angle>` sources, raw `<img src>` and reference-style images are all scanned.

A failing proposal is **refused**: nothing staged, nothing triaged (a person cannot repair a missing
upload), and not ledgered, so re-sending the same batch after the upload stages it. Batches list refused
docs under an optional `refused: [{ slug, reason }]` (absent when empty, so existing responses are
unchanged); `/api/docs/propose` answers 400; triage assign throws.

## Serving and rendering

- `GET /img/<sha>`: session cookie; exact bytes with the stored type, `nosniff`,
  `default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`; 404 unknown or
  malformed, 401 without a session.
- Docs reader: `enhance()` wraps each `/img/` image in a zoom button that opens the shared lightbox
  (`web/src/lightbox.ts`), lazy-loaded.
- Review: the Rendered view shows a line's images, outlined green when added and dimmed red when removed,
  with the alt text as caption; unified and split diffs show the markdown line.

## Agents learn it from

The `upload_asset`, `propose_doc_update` and `record_session` tool descriptions; the `canopy` and
`record-session` skills (the latter may now call `upload_asset` and the hash / PUT commands); and
`docs/artifact-contract.md` › Doc images.

## Deferred

A signed agent download for doc images (like `artifact_get`'s), web upload, garbage collection.

## Testing

`test/doc-images.test.ts` (real D1 + local R2, real MCP closures, real Worker entry): the scan; mint,
PUT, dedupe, refusals, retry and 410; the default artifact destination and the removed old name; the gate
across `propose_doc_update`, `record_session` (refused list, resend stages), triage assign and
`/api/docs/propose`; `/img` bytes, headers, 401 and 404. `test/render.review.test.ts`: the Rendered view
shows images, marks removals, and escapes alt text.
