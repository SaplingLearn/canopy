# Harden Docs spaces to a fixed {Technical, Product} vocabulary

Date: 2026-07-10
Status: Approved (ready for implementation plan)

## Problem

The Docs page shows three tabs — Technical, Product, and a stray **Sapling** — and there is no
guarantee about which tabs exist. Two independent defects combine to cause this:

1. **The tabs are data-derived, not fixed.** `web/src/render.ts` builds the space toggle from the
   distinct `space` values present in the docs (`orderedSpaces()` → `new Set(docs.map(d => d.space))`),
   labeling each by capitalizing the raw value. So *any* `space` value in the data becomes a tab, and a
   new value would silently add one.
2. **The write side speaks a different, unmatched vocabulary.** A doc's `space` is constrained to
   `sapling | canopy` (in `shared/contract.ts`, the MCP `query` / `propose_doc_update` tools, and the
   gate), and new docs **default to `canopy`** — a vocabulary that never matched the Technical | Product
   model the UI was rebuilt around. Because the gate defaults to `canopy`, the next agent-written doc
   would spawn a *new* "Canopy" tab.

The write model and the display model are disconnected, and nothing pins the tab set. The "Sapling" tab
is simply the one doc still carrying `space='sapling'`.

### Live data (read-only inspection of prod, 2026-07-10)

- `product` — 17 docs (Overview, Features ×15, Brand & Marketing). All genuinely product.
- `technical` — 12 docs (Architecture, ADRs/Decisions, Engineering Guide).
- `sapling` — exactly **1 doc**: `sapling-frontend-local-dev` ("Frontend Local Dev — npm 10.9.x & the
  lockfile guard", section `reference`). Plainly an engineering doc → belongs in **technical**.
- No `canopy`-spaced docs exist.
- Prod D1 is fully migrated through `0019` (matches the repo). The technical/product/sapling data
  spacing was applied out-of-band, not via any tracked migration — the *data* drifted, not the schema.

## Goals

- Remove the Sapling tab.
- Harden the space tabs so they cannot be changed or added to: a fixed **{technical, product}**
  vocabulary enforced on every surface.
- Ensure the doc-write path places docs in the right space (default `technical` when omitted).

## Decisions (locked with the user)

1. `space` is a fixed enum of exactly **`technical | product`**. When an agent omits it, the doc
   defaults to **`technical`** (the engineering default).
2. Enforcement is a **hard enum**: a doc proposal carrying an off-vocab space fails contract/tool
   validation (an error), rather than being silently routed to triage.
3. The single `sapling`-spaced doc is re-homed by content — `sapling-frontend-local-dev` → `technical`.
4. Scope is **spaces/tabs only**. The parallel section-vocab disconnect is explicitly out of scope.

## Design

### 1. Vocabulary — single source of truth

`space ∈ {technical, product}`, default `technical`, expressed as `z.enum(["technical","product"])` on the
write contract and MCP tool inputs. `space` remains typed `string` on the D1 row (`shared/rows.ts`) since
the column is `TEXT`; the enum lives at the write boundary. This is deliberately kept out of
`shared/vocabulary.ts` (which is the gate's section/tag vocab) because space is enforced structurally at
the Zod boundary, not routed through the section/tag gate.

### 2. Write path

- `shared/contract.ts` — `DocProposal.space` (line 28) and `QueryRequest.space` (line 76) enums →
  `["technical","product"]`. `DocProposal.space` stays `.optional()` (server defaults `technical`); fix
  the trailing comment.
- `src/mcp.ts` — the `query` tool space enum (line 51) and the `propose_doc_update` tool space enum
  (line 110) → `["technical","product"]`. Update the `propose_doc_update` description to name the two
  spaces.
- `src/consumer.ts` — gate default (line 181) `space: proposal.space ?? "technical"` (was `"canopy"`).
- `src/tools/writes.ts` — the two `space?: "sapling" | "canopy"` annotations (lines 52, 413), the
  `proposal.space ?? "canopy"` fallback (line 77) → `"technical"`, and the
  `raw.space as "sapling" | "canopy" | undefined` cast (line 463) → `"technical" | "product"`.
- `shared/rows.ts` — fix the `space` comment (line 13) to describe `technical | product`.

### 3. Docs UI — fixed tabs (the "can't be added" guarantee)

In `web/src/render.ts`:

- Introduce `const DOC_SPACES = ["technical", "product"] as const` as the single ordering/source list;
  remove `DOC_SPACE_ORDER` (line 499) and the `orderedSpaces()` function (lines 501–504).
- Replace the data-derived tab construction (lines 400–403): iterate `DOC_SPACES` directly and **always**
  render both tabs (drop the `docSpaces.length > 1` conditional). The selected-state styling in
  `spaceTab` is unchanged; `spaceLabel` capitalization already yields "Technical" / "Product".
- The default `docSpace: "technical"` (line 108), the tree filter `d.space === s.docSpace` (line 541),
  and `firstDocForSpace` are unchanged.

Result: exactly two tabs render regardless of data, so a stray space value can no longer add a tab, and an
agent cannot introduce one (the enum rejects it at the tool boundary).

### 4. Triage "assign" surface

The human "assign a triaged item into a space" flow carries the same stale vocab and must move in lockstep:

- `web/src/triage-map.ts` — `ASSIGN_OPTIONS.spaces` (line 116) → `["technical","product"]`.
- `web/src/api.ts` — `AssignTarget.space` type (line 225) → `"technical" | "product"`.
- `src/routes.ts` — the assign body type annotation (line 168) → `technical | product`.
- `web/src/main.ts` — the `state.assignSpace` guard (line 720) → `technical | product`.

Also the `GET /search` space-filter parse (`src/routes.ts:66`, `spaceRaw === "sapling" || "canopy"`)
belongs to the read path and moves in lockstep → `technical | product`.

### 5. Data migration

`migrations/0020_docs_space_vocab.sql`:

```sql
-- Normalize the docs space vocabulary to exactly {technical, product}. Folds the
-- single stray 'sapling' doc (an engineering reference → technical) and any future
-- off-vocab value into the default. Idempotent; a no-op on fresh local/test DBs.
UPDATE docs SET space = 'technical' WHERE space NOT IN ('technical', 'product');
```

Applied to prod via `npm run db:migrate:remote`. No FTS rebuild is required — the docs FTS index
(`docs_fts`) does not include `space`.

### 6. Testing

- Worker gate: assert an omitted `space` defaults to `technical` (extend `consumer.vocab-gate` /
  `mcp.propose_doc`), and that the contract rejects an off-vocab space value.
- Render: add `test/render.docs.test.ts` asserting exactly the two fixed tabs (Technical, Product) render
  and no third tab appears even when a doc with a foreign `space` is present in state.
- Gates for "green": `npm test`, `npm run typecheck`, `npm run build:web`.

## Out of scope

- The parallel **section** vocab disconnect (the gate's `SECTIONS` = `reference/context/decisions/
  needs-triage` vs the UI's Architecture / Engineering Guide / Decisions groups).
- Cosmetic note: the migrated `sapling-frontend-local-dev` keeps section `reference`, so it renders as a
  lowercase "reference" group under Technical alongside "Architecture" / "Engineering Guide". Left
  untouched by design (spaces-only scope); flagged as a possible future section cleanup.
```
