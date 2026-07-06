# Local seed data, wired across every surface

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan

## Problem

Canopy used to ship a local dev seed — `scripts/seed-dev.sql`, applied to local D1 after
migrations, paired with `scripts/dev-cookie.mjs` (forges a signed session cookie) and
`scripts/dev-shot.mjs` (CDP screenshot). It populated docs, feed, ADRs, needs-triage,
milestones, and a `focus` row so every web surface had data locally.

The data model then shifted and the seed rotted into a no-op that actively errors:

- `seed-dev.sql` does `INSERT INTO focus (...)`, but `focus` was **dropped in migration
  `0014`**. That statement alone aborts the whole seed.
- **My Work** no longer reads `focus` + `feed`. `src/tools/mywork.ts` is now a D1-only
  projection over captured GitHub `events` joined to the `people` identity map, plus
  `pr_summaries` / `issue_summaries`. The old seed populates none of these.
- **Roadmap** is now an admin-authored `plan` (singleton narrative + `plan_versions`
  snapshots) over `milestones` (which gained a `phase` column) merged with a
  `milestone_progress` cache. The old seed sets no `plan`, no `phase`, no progress.
- Tables with **zero** seed coverage today: `events`, `pr_summaries`, `issue_summaries`,
  `milestone_progress`, `plan`, `plan_versions`, `identity_tasks`. Docs never get `space` set.

Net effect: My Work and Roadmap render empty locally, and Docs/Feed/Search/Triage would
work only if the seed didn't abort on the `focus` line first.

## Goal

Restore a single local dataset that lights up **every** surface — My Work, Feed, Docs,
Roadmap, Triage, Search — against the *current* schema, wired in through the local-mode
toggle that already exists so bringing it up is one command.

Non-goals: changing any runtime read path; seeding the remote/production database
(`build-prod-seed.mjs` / `seed-prod.sql` are separate and out of scope); adding a new auth
flow (the `DEV_LOGIN` bypass already exists).

## Approach (chosen)

**Option A — the toggle loads JSON into D1; the app reads D1 unchanged.**

JSON fixture files are the source of truth. A loader resets local D1 and inserts them. Every
existing read path — window-function joins in My Work, FTS5 in Search, the plan+milestones+
progress merge in Roadmap — runs unchanged against D1. The seed is content only; it never
introduces a parallel read implementation, so it cannot lie about how the app behaves.

Rejected alternatives:

- **Read JSON directly at runtime (bypass D1).** Would need a second read implementation per
  surface that drifts from the real SQL and never exercises FTS/joins/progress. Rejected.
- **Drive the real HTTP write paths (`/webhook/github` + `/ingest`).** Higher fidelity but
  needs a running server, HMAC signing, and a readiness dance. Overkill for a local seed;
  the FTS triggers already give us schema-faithful indexing without it.

## The toggle

The local-mode toggle already exists: `DEV_LOGIN` in `.dev.vars` (`src/auth/principal.ts:49`)
bypasses OAuth and makes the app act as a seeded user. It never exists in prod vars/secrets,
so it is inert there. `DEV_LOGIN` answers *who you are*; this work adds the missing half —
*the data that user sees*.

- `npm run seed` runs the loader.
- The loader **hard-refuses `--remote`**: it only ever executes against the local sqlite
  (`wrangler d1 execute canopy --local`). This is the guardrail against touching production.
- The loader lives in `scripts/` and is never imported by the worker — no seed code or
  fixtures ship in the deployed bundle.

## Components

### 1. Fixture files — `fixtures/dev/*.json`

Plain JSON, one file per surface, hand-authored and diffable. For `events.json`, each entry
is a GitHub-webhook-shaped payload identical to what lands in `events.raw` — realistic and
reusable. Files: `docs.json`, `feed.json`, `adrs.json`, `triage.json`, `roadmap.json`
(plan narrative + milestones), `events.json`, `identity.json`.

Fixture location is `fixtures/dev/` at repo root.

### 2. Loader — `scripts/seed-dev.mjs`

1. Refuse if invoked with `--remote` or any target other than local.
2. **Reset**: run the exact truncation statement from `test/apply-migrations.ts:18` (same
   FK-safe delete order, same `people` re-seed). Keeping one canonical reset list means the
   seed cannot drift as migrations add tables.
3. **Load**: read each fixture, build parameter-safe INSERTs (JSON string bodies escaped
   correctly), and apply them to local D1. Order respects FKs
   (`events` before `pr_summaries`; `milestones` before `milestone_progress`).
4. FTS5 (`docs_fts` / `feed_fts` / `adrs_fts` / `roadmap_fts`) is populated automatically by
   the DB triggers on insert — no direct FTS seeding.

Re-running is a clean reset-then-load (idempotent).

### 3. `package.json`

Add `"seed": "node scripts/seed-dev.mjs"`. (Whether `npm run dev` chains it is left to the
plan; the explicit command is the contract.)

## Identity wiring

My Work only surfaces work whose `subject_login` / issue assignee **matches the logged-in
user**, resolved through `people`. The seed is coherent only when three things line up:

    DEV_LOGIN  ==  a row in people  ==  subject_login on the seeded events

**Decision:** use `AndresL230` — already a migration-seeded person and the `ADMIN_LOGINS`
value, so admin-only Triage actions work in the same local session. Seeded PR/issue events
carry that subject. The loader re-asserts the four migration `people` rows so it is
self-contained.

## Coverage matrix

| Surface | Tables seeded | Result |
|---|---|---|
| Docs | `docs` + `doc_versions` (with `space`) | Docs across reference/context/decisions; one carries a **staged newer version** |
| Feed | `feed` + `entry_tags` | Several tagged entries |
| Roadmap | `plan` + `plan_versions`, `milestones` (`phase`; done/in-progress/upcoming), `milestone_progress` | Narrative + milestones with real closed/total progress |
| My Work | `events` (pr_merged/closed + open issues assigned to `DEV_LOGIN`), `pr_summaries`, `issue_summaries` | Previous-activity list + a to-do list with priorities/labels |
| Triage | `needs_triage`, staged `doc_versions`, `adrs` draft, staged `milestone_proposals`, `identity_tasks` | All four triage queues populated |
| Search | *(none — FTS triggers auto-fill)* | Ranked hits across docs/feed/ADRs/roadmap |

The staged doc version, ADR draft, milestone proposal, and one `identity_tasks` row (raised
by an event from an unmapped login) exist so Triage's Review **and** Maintenance surfaces
both have something to act on.

## Data flow

```
fixtures/dev/*.json ──> scripts/seed-dev.mjs ──> local D1 (reset + INSERT)
                                                     │
                                        FTS triggers fire on insert
                                                     │
   wrangler dev (DEV_LOGIN=AndresL230) ── reads D1 unchanged ──> every web surface
```

## Idempotency & safety

- Reset list is the single canonical copy from `test/apply-migrations.ts`; re-running
  `npm run seed` is a clean reset+load.
- The loader refuses `--remote`; it can only ever write local sqlite.
- No fixtures or seed logic are reachable from the worker bundle.

## Testing

One Vitest file on the Miniflare D1 harness that applies the generated seed and asserts each
read path returns non-empty:

- `getMyWork('AndresL230')` returns non-empty `previousActivity` **and** `todo`.
- Roadmap read returns milestones carrying progress.
- `query()` returns hits for a known term across types.
- The staged-proposals join returns at least one row.

This test is the guard that keeps the seed honest as the schema evolves — the same reason the
reset list is kept in one place.

## Open questions

None blocking. `npm run dev` auto-seeding vs. explicit `npm run seed` is an ergonomics detail
to settle in the plan; the explicit command is the contract either way.
