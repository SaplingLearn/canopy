# The artifact contract

What an agent (or a person) can do with Canopy **artifacts** — versioned pages the team keeps next to
its tickets and sprints: a rendered HTML page, a markdown doc, an SVG, a mermaid diagram, an image, a
PDF or any other file. Issue #52; implementation spec:
`docs/superpowers/specs/2026-09-24-artifacts-implementation.md`. The shared vocabulary and caps live
in `shared/artifacts-core.ts` — if this page and that file disagree, the file wins.

## Kinds and caps

| Kind | Stored | Cap | How you send it |
|---|---|---|---|
| `html` · `markdown` · `svg` · `mermaid` | text, in D1 | 500 KB (UTF-8 bytes) | inline `content` |
| `image` (png / jpeg / gif / webp) · `pdf` · `file` | bytes, in R2 at `artifacts/<sha256>` | 10 MB | a signed upload URL (below) |

A page's kind never changes. A `file` that claims an active type (`text/html`, `image/svg+xml`,
JavaScript, XML …) is stored as `application/octet-stream`, so it can only ever be downloaded.

Every page has a `title` (≤ 200), an `area` (`auth` · `architecture` · `infra` · `api` · `ui` ·
`data`), a `repo` (`owner/repo` or `""`), a `visibility` (`org` or `private`), versions (each with a
`summary` ≤ 500 characters) and links to `ticket` / `sprint` / `pr` / `issue`. The slug is derived from
the title (lowercase, dashes, ≤ 60 characters, `-2`, `-3` … on a collision) and never changes.

## Statuses

```
create                 → v1, status draft
draft ⇄ published      → anyone who can read the page (web)
any new version        → published, and any ratification is cleared
published → ratified   → a PERSON, on the web, only the latest version
```

Only **`ratified`** is team-confirmed. `draft` and `published` are one person's word; `query` flags a
draft as authority `draft` and a published or ratified page as `live`, and an artifact's query body
starts `Status: <status> · v<n>` so you can tell which.

## Who can do what

- **See** a page: everyone in the org when it is `org`; only its author when it is `private`.
- **Write** a page (add a version, draft ⇄ published, title / area / repo, links): anyone who can see it.
- **Make a page private**: its author only.
- **Ratify**: any signed-in person, **on the web only** (a session-cookie route). There is no MCP tool
  for it and no way to reach it from an agent — the same rule as promoting a doc or ratifying an ADR.
- A **missing** slug, a page that is **private to someone else**, and a binary page whose upload has
  **not landed yet** are the same answer — `404 { "error": "not_found" }` over HTTP,
  `{ "error": "not_found", "code": "not_found" }` over MCP. The check is never an existence oracle.

An artifact write is a **direct authored write** (like a ticket), not staged knowledge: it takes effect
immediately and is recorded as you. Nothing marks it agent-made.

## The three MCP tools

Registered for every principal; the author and viewer is always your bearer's person.

**`artifact_create`** `{ title, kind, area, repo, visibility, content?, links?, summary?, size_bytes?, sha256?, content_type?, filename? }`

- Text kinds: `content` is required → `{ id, slug, url, version, warnings }`.
- Binary kinds: `size_bytes` + `sha256` are required and `content` is refused →
  `{ id, slug, url, upload_url, expires_at, warnings }`. An `image` needs a `content_type` or a
  `filename` whose extension names the type.
- `links`: `[{ target_type, target_ref }]` — a ticket or sprint id (it must exist), or a PR / issue as
  `#n` (resolved against the page's `repo`), `owner/repo#n` or a GitHub URL.

**`artifact_update`** `{ slug, summary, content? | old_str + new_str, size_bytes?, sha256?, content_type?, filename? }`

- Text pages: the whole new `content`, **or** `old_str` + `new_str` — an exact edit of the latest
  version, where `old_str` must occur **exactly once** → `{ id, slug, url, version, unchanged, warnings }`.
  Content identical to the latest version writes nothing and returns `unchanged: true`.
- Binary pages: `size_bytes` + `sha256` → `{ id, slug, url, upload_url, expires_at, warnings }`.

**`artifact_get`** `{ slug, version? }` — `slug` may carry a version (`slug@v3` or `slug/v3`); default
the latest. Returns the page's metadata, versions and links; for text kinds `content` is that version's
text, for binary kinds `content` is `null` and `raw_url` is the file.

`url` is the page in the Canopy web app (`<origin>/#artifacts/<slug>`); `upload_url` and `raw_url` are
absolute too. **Every result carries `warnings: string[]`** — non-empty when text content calls into
something only claude.ai provides (`window.claude`, `window.storage`, `api.anthropic.com`). That is a
warning, never a rejection: the write has already happened, and the page will not work in Canopy's
viewer until you remove the call.

Also: `query` searches artifacts (type `artifact`, id = the slug; private pages only for their author),
`get_ticket` lists the pages linked to a ticket that you can see (`artifacts: [{ slug, title, kind,
status, version }]`), and `record_session` accepts `artifact_links: [{ slug, target_type, target_ref }]`
for the artifacts a session produced — linked after the batch is reconciled, each reported as `linked`
/ `not_found` / `error`.

## Uploading a binary

Two steps: declare the file, then PUT the exact bytes.

```bash
# 1. Hash it
shasum -a 256 threat-model.pdf
#   9f2c…e41a  threat-model.pdf
wc -c < threat-model.pdf
#   482113

# 2. artifact_create (or artifact_update for a new version) with the size and hash
#    { "title": "Threat model", "kind": "pdf", "area": "infra", "repo": "", "visibility": "org",
#      "size_bytes": 482113, "sha256": "9f2c…e41a", "filename": "threat-model.pdf" }
#    → { "slug": "threat-model", "upload_url": "https://canopy…/api/artifacts/upload/<token>", "expires_at": "…" }

# 3. PUT the bytes
curl -X PUT --data-binary @threat-model.pdf -H "Content-Type: application/pdf" "<upload_url>"
```

- The URL is the credential: **single use, valid 5 minutes**, bound to your person, the page, the kind,
  the size, the hash, the type, the filename and the summary. No cookie or bearer on the PUT.
- A body whose length or SHA-256 does not match what you declared is refused (400) and the same URL may
  be retried until it expires; an expired or used URL is `410`. Ask for a fresh one with
  `artifact_update` on the same slug (the author may do that even before the first upload landed).
- Until the PUT lands, a new page does not exist to anyone — not even in your own `artifact_get`.
- Re-uploading bytes identical to the latest version writes nothing.

## The raw route

`GET /raw/a/<slug>` (latest), `/raw/a/<slug>@v<n>` or `/raw/a/<slug>/v<n>` serves the bytes with
locked-down headers (a sandboxing CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Cache-Control: private`). `?download=1` forces an attachment named `<slug>-v<n>.<ext>`. It is
**session-cookie only**: it opens in a signed-in browser, not with an MCP bearer — an agent reads text
content through `artifact_get` instead.
