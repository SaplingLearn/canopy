# Querying Canopy — the `query` tool in full

`query` is Canopy's one ranked, full-text read engine (FTS5 + bm25). It assembles the **whole
authoritative body** of the top hits and returns **ranked pointers** to the rest, each result
authority-flagged. Use it to orient, to search, and to explore — there is no second search path.

## Parameters

| param | type | default | what it does |
|---|---|---|---|
| `q` | string | `""` | the search text. **Empty `q` → browse mode** (recency-ordered, filtered by the params below). |
| `types` | `("doc"\|"decision"\|"feed")[]` | all | restrict to one or more record types. |
| `section` | string | — | restrict docs to a section (docs only). |
| `space` | `"sapling"\|"canopy"` | both | restrict docs to a space (docs only). |
| `include_staged` | boolean | **true via MCP**, **false via `/search`** | whether staged / unpromoted / draft content is returned. Agents see it (flagged); the human Search UI hides it. |
| `limit` | number | 6 | how many **full-body** primary hits to assemble. |
| `pointer_limit` | number | 20 | how many ranked **snippet** pointers to return beyond the primaries. |

## What comes back

```
{
  primary:  [ { type, id, title, section, space, body /* FULL */, authority,
                current_version, pending_version, staged_body, confidence,
                updated_at, updated_by, score } ],
  pointers: [ { type, id, title, snippet, authority, score } ],
  meta:     { engine: "fts5", total }
}
```

- **`primary`** carries the full current authoritative `body` — read these.
- **`pointers`** carry a `snippet` only — scan them, then open anything worth reading with
  `get_doc <slug>` (or a follow-up `query`).
- **`score`** is normalized so higher = better. Title/summary terms are weighted above body terms.
- **`authority`** is on every item — see the loop skill; never treat non-`live` as settled. When
  `include_staged` is true and a doc has a pending version, `pending_version` and `staged_body` are
  populated so you can inspect the proposed change without it being live.

## Patterns

- **Orient before work** (what `load-context` does): a *tight* `q` (the subsystem/concept) + `types`
  + `section`. A focused query assembles better bodies than a broad one. Read the `primary` bodies;
  note a doc's `current_version` if you're about to propose a change (it's the writer's `base`).
- **Ad-hoc search**: a natural-language `q`, no type filter, let `primary` + `pointers` show
  depth-and-breadth. Raise `pointer_limit` to fan wider.
- **Browse a space/section**: empty `q` + `space`/`section`/`types` → recency-ordered listing.
- **Cross-space check**: query with `space:"sapling"` then `space:"canopy"` (or omit `space` for both)
  when the same concept may live in either.
- **Inspect a pending change**: query with `include_staged: true` and read `staged_body` vs `body`.

## When to use which read tool

- **`query`** — you're searching/exploring/orienting by concept. Default choice.
- **`get_doc <slug>`** — you already know the exact slug and want all its versions.
- **`get_feed`** — you want the activity timeline (filter by author/tags/since).
- **`get_roadmap`** — you want milestones + live GitHub progress.

`query` is read-only and safe to call freely.
