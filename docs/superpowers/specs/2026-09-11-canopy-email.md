# canopy-email.md

Email notifications for Canopy via Resend. Supersedes the earlier two-email shape (weekday My Work digest plus a separate review nudge). Status: architecture locked, not built. Date: 2026-09-11.

## 1. Scope

Email is a read-side projection of Canopy state. It reads the event spine, D1 queue state, and D1 version rows, renders per recipient, and sends. It never writes.

Non-goals, permanently:

- Inbound email of any kind (reply-to-post, reply-to-approve). Would be a fourth credential class outside the bearer/cookie invariant.
- Signed action tokens in URLs. Mail forwarding and corporate scanner prefetch make them replayable and self-firing.
- Per-event or immediate email. Cadences are daily, weekly, off. No fourth tier.

Links in email deep-link to a surface. The OAuth redirect with return-to handles auth. All actions happen in-app.

## 2. Kind registry

Lives in code under `shared/` (Zod-typed), not D1. One entry per notification kind:

```ts
type Cadence = 'daily' | 'weekly' | 'off';

interface NotificationKind {
  id: string;                          // stable, used as key in D1
  label: string;                       // shown in Settings and Maintenance
  description: string;                 // one line, shown in Settings
  defaultCadence: Cadence;
  allowedCadences: Cadence[];          // always includes 'off'
  render(userId: string, window: Window): Promise<Section | null>;
}

interface Window { cadence: 'daily' | 'weekly'; start: Date; end: Date; id: string; }
interface Section { heading: string; html: string; text: string; deepLink: string; }
```

Renderer contract:

- Pure read. No D1 writes, no event emission, no GitHub calls.
- Reads whatever source is authoritative for that kind. Not required to read the event spine.
- Returns `null` when there is nothing to say for this user in this window. Null sections are dropped, never rendered as "no updates."

Initial registry:

| id | default | allowed | source |
|---|---|---|---|
| `my_work` | daily | daily, weekly, off | event spine: merged PRs in window (summarized), open assigned issues |
| `review_queue` | daily | daily, off | D1 triage: open Proposals and Decisions count, top items |
| `roadmap_plan` | weekly | daily, weekly, off | D1 roadmap version rows: plan-layer diffs in window |

Adding a kind is one registry entry plus one renderer. No migration. Settings and Maintenance UIs iterate the registry, so new kinds appear without frontend changes. `notification_policy` is seeded from the registry on first run and on deploy for any missing kind.

## 3. Cadence resolution

Three layers, first match wins:

1. `notification_prefs` row for (user, kind) if present
2. `notification_policy.default_cadence` for kind
3. `NotificationKind.defaultCadence`

Absence at a layer means inherit. Changing a registry default propagates to everyone who never overrode.

Admin authority is limited to existence: `notification_policy.enabled = false` turns a kind off org-wide and the user layer is not consulted. Everywhere else the individual pref wins. Admin cannot force a cadence onto someone.

A user pref must be in `allowedCadences` for that kind. Validate at write time via Zod.

## 4. Runs and assembly

Two Cron Triggers, org-level schedule:

- Daily: Monday to Friday at `policy.send_hour` in `policy.timezone`. Window is the previous 24h (Monday covers Friday send to Monday send).
- Weekly: Monday at `send_hour`. Window is the previous 7 days.

Per run, per user with an email on file and `unsubscribed = 0`:

1. Resolve cadence for every registry kind.
2. Select kinds whose resolved cadence equals the run cadence.
3. Insert outbox row with status `pending` using key `${user_id}:${cadence}:${window_id}`. Unique constraint. On conflict, skip the user entirely (the run already happened).
4. Call each selected renderer. Drop nulls.
5. Zero sections: set outbox status `skipped`, no send.
6. One or more: assemble one message, send via Resend, set status `sent` with `resend_id`. On failure set `failed` with error; a retry job may re-attempt `failed` rows only.

One email per user per run. Registry growth does not increase inbox volume.

`window_id`: `YYYY-MM-DD` for daily, `YYYY-Www` (ISO week) for weekly.

## 5. Data model

```sql
CREATE TABLE notification_policy (
  kind TEXT PRIMARY KEY,
  default_cadence TEXT NOT NULL CHECK (default_cadence IN ('daily','weekly','off')),
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE notification_settings (      -- single row, org-level
  id INTEGER PRIMARY KEY CHECK (id = 1),
  send_hour INTEGER NOT NULL DEFAULT 8,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  from_address TEXT NOT NULL
);

CREATE TABLE notification_prefs (          -- sparse, override only
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','off')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE notification_outbox (
  idempotency_key TEXT PRIMARY KEY,        -- user:cadence:window_id
  user_id TEXT NOT NULL,
  cadence TEXT NOT NULL,
  window_id TEXT NOT NULL,
  kinds TEXT NOT NULL,                     -- JSON array of kind ids rendered
  status TEXT NOT NULL CHECK (status IN ('pending','sent','skipped','failed')),
  resend_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
```

Teammate record gains `email TEXT` and `email_unsubscribed INTEGER NOT NULL DEFAULT 0`. No prefs are deleted on unsubscribe; unsubscribe is a hard gate above resolution.

## 6. Roadmap renderer

The plan layer is admin direct-write via local skills and emits nothing on the event spine. No new event is added. The renderer diffs roadmap version rows whose `created_at` falls in the window against the last version before the window:

- Milestone added
- Milestone title or description changed
- Milestone reordered
- Milestone confirmed done (human confirmation only, per existing rule)

Progress-layer changes are excluded. They derive from PR merges already covered by `my_work`. Renders null when no plan rows changed in the window, which will be most daily windows; weekly default reflects that.

## 7. Delivery

- Resend via HTTPS from the Worker. API key in a Worker secret.
- Sending domain is a subdomain (e.g. `mail.canopy.saplinglearn.com`) with SPF, DKIM, DMARC. Apex reputation stays isolated.
- Headers: `List-Unsubscribe` (mailto and https) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The https target is a cookie-gated route that flips `email_unsubscribed`; one-click POST from mail clients is handled by a signed unsubscribe path, which is the single exception to the no-token rule because the only action it can perform is turning email off.
- Addresses: GitHub OAuth primary email is unreliable (private or noreply alias). Email is a field on the teammate record, editable by the user in Settings and by admin in Maintenance. Users with no address are skipped at run time and see a prompt in Settings.
- Subject: `Canopy daily, Sep 11` / `Canopy weekly, Sep 7 to 11`. Plain text alternative always included.

## 8. Surfaces

Settings (per user):
- Email address field with verification state (set, missing).
- One row per enabled registry kind: label, description, cadence control limited to `allowedCadences`. Shows inherited value with an "org default" marker until overridden; "reset to default" clears the pref row.
- Kinds with `policy.enabled = 0` are hidden, not shown disabled.
- Global unsubscribe toggle.

Maintenance (admin):
- Notification policy table: one row per registry kind, `enabled` toggle, `default_cadence` select.
- Org schedule: `send_hour`, `timezone`, `from_address`.
- Recent outbox view: last N rows with status, useful for confirming a run fired.

## 9. Dev mode and testing

`ENV=local` writes outbox rows and renders full message bodies to a `notification_outbox_bodies` dev-only table (or logs) without calling Resend. A `--to` override sends everything to one dev address for visual checks.

Tests assert on rows, not mocks:

- Running the daily cron twice for the same window produces exactly one outbox row per user.
- A user whose renderers all return null gets a `skipped` row and no send.
- A user with `email_unsubscribed = 1` gets no row.
- Kind with `policy.enabled = 0` is never rendered regardless of user pref.
- User pref of `weekly` on `my_work` excludes that section from the daily run and includes it in the weekly run.
- Roadmap renderer returns null when only progress rows changed in the window.

Per existing posture: any test that stays green if the fix is reverted is broken.

## 10. Build order

1. Registry types and the three renderers, unit tested against fixtures.
2. Migration for the four tables plus teammate columns; policy seeding.
3. Resolver and run assembler with outbox, local mode only.
4. Cron wiring and Resend client behind an env gate.
5. Settings and Maintenance UI wired to `/api/notifications/*` (cookie).
6. Domain provisioning and first live send to the team.
