// THE single mock-data module for the componentized triage surfaces (Review +
// Maintenance), transcribed from Canopy Triage.dc.html. Components never define
// data of their own — everything they show flows from here through props. When
// the backend reads land, this module is swapped for real reads and prop names
// adjusted; nothing structural changes.

import type { ReviewItem } from "./review";
import type { UnplacedItem, AssignOptions, IdentityGroup, Person } from "./maintenance";

export const MOCK_REVIEW_ITEMS: ReviewItem[] = [
  {
    id: "p1", kind: "proposal", eyebrow: "PROPOSAL · DOCS / RUNBOOKS", badge: "STAGED", badgeColor: "var(--amber)",
    title: "Deployment Runbook", summary: "Rollback section rewritten: --confirm flag now required, migrations no longer auto-revert.",
    agent: "agent · session 4f2c", agentInitials: "A4", time: "18m ago",
    stale: true, staleNote: "Proposed from v6 — the live doc is now v8. Two newer edits landed since this draft; review against current content before promoting.",
    liveVersion: "LIVE (v8)",
    diff: [
      { t: "h", s: "## Rolling back a bad deploy" },
      { t: "ctx", s: "Identify the last known-good release in the deploys channel." },
      { t: "del", s: "Run `canopy rollback --env prod` and wait for the health check to pass." },
      { t: "add", s: "Run `canopy rollback --env prod --confirm`. The flag is required since v2.3; the bare command now dry-runs." },
      { t: "add", s: "Watch the health check in #deploys — rollback is not complete until it reports green twice." },
      { t: "ctx", s: "If the rollback fails, page the on-call before retrying." },
      { t: "gap" },
      { t: "h", s: "## Database migrations" },
      { t: "del", s: "Migrations are rolled back automatically with the release." },
      { t: "add", s: "Migrations are NOT rolled back automatically. Use `canopy db down <version>` after confirming no writes depend on the new schema." },
      { t: "ctx", s: "Record the incident in the postmortem template either way." },
    ],
  },
  {
    id: "d1", kind: "decision", eyebrow: "DECISION · ADR-014", badge: "DRAFT", badgeColor: "var(--blue)",
    title: "Adopt outbox pattern for event publishing", summary: "Events written in the same transaction as state; a relay publishes from the outbox table.",
    agent: "agent · session 9b1e", agentInitials: "A9", time: "1h ago",
    adr: [
      { h: "Context", p: "Services publish domain events directly to the broker after committing their transaction. When the publish fails, state and events diverge silently — we found three inconsistencies during the March audit, all traced to dropped events." },
      { h: "Decision", p: "Write events to an outbox table in the same transaction as the state change. A relay process reads the outbox and publishes to the broker with at-least-once delivery. Consumers stay idempotent, which they already must be." },
      { h: "Consequences", p: "Publishing gains one hop of latency (~200ms p99, acceptable for every current consumer). The relay is new operational surface: it needs a dashboard and an alert on outbox lag. Direct-publish code paths are removed once all services migrate." },
    ],
  },
  {
    id: "p2", kind: "proposal", eyebrow: "PROPOSAL · DOCS / POLICIES", badge: "STAGED", badgeColor: "var(--amber)",
    title: "Retry & Backoff Policy", summary: "New section on outbound HTTP retries: exponential backoff with jitter, idempotent-only.",
    agent: "agent · session 4f2c", agentInitials: "A4", time: "2h ago",
    liveVersion: "LIVE (v3)",
    diff: [
      { t: "h", s: "## Outbound HTTP calls" },
      { t: "ctx", s: "All service-to-service calls go through the shared client." },
      { t: "add", s: "Retries use exponential backoff with full jitter: base 200ms, cap 8s, max 5 attempts." },
      { t: "add", s: "Only idempotent requests (GET, or PUT with an idempotency token) are retried automatically." },
      { t: "add", s: "Non-idempotent calls surface the failure to the caller — never retry blind." },
      { t: "ctx", s: "Timeouts stay at 10s unless the endpoint declares otherwise." },
    ],
  },
  {
    id: "p3", kind: "proposal", eyebrow: "PROPOSAL · DOCS / ONBOARDING", badge: "STAGED", badgeColor: "var(--amber)",
    title: "Onboarding: local environment", summary: "Node version bumped to 20 to match .nvmrc.",
    agent: "agent · session 77aa", agentInitials: "A7", time: "5h ago",
    liveVersion: "LIVE (v11)",
    diff: [
      { t: "h", s: "## Prerequisites" },
      { t: "del", s: "Install Node 18 and Docker Desktop." },
      { t: "add", s: "Install Node 20 (see .nvmrc) and Docker Desktop." },
      { t: "ctx", s: "Copy `.env.example` to `.env.local` and fill the secrets from 1Password." },
    ],
  },
  {
    id: "d2", kind: "decision", eyebrow: "DECISION · ADR-015", badge: "DRAFT", badgeColor: "var(--blue)",
    title: "Consolidate background jobs onto one queue", summary: "Retire the cron runner and the ad-hoc worker pool; everything moves to the job queue.",
    agent: "agent · session 9b1e", agentInitials: "A9", time: "1d ago",
    adr: [
      { h: "Context", p: "Background work runs in three places: the job queue, a cron runner, and an ad-hoc worker pool spun up for imports. Only the queue has retries, dead-lettering, and visibility. The other two fail silently." },
      { h: "Decision", p: "All background work moves to the job queue. Scheduled work becomes queue jobs enqueued by a single scheduler. The cron runner and worker pool are retired at the end of the quarter." },
      { h: "Consequences", p: "One place to look when a job fails. Imports gain retries for free. The migration touches eleven jobs; two need their idempotency reworked first (tracked on the roadmap)." },
    ],
  },
];

export const MOCK_UNPLACED: UnplacedItem[] = [
  {
    id: "u1", title: "Notes on connection pool sizing",
    snippet: "“Pool exhaustion under load traces to the reporting service holding connections across the whole export. Suggest capping per-service pools and moving exports to a read replica…”",
    reason: "AGENT FLAGGED", meta: "agent · session 9b1e · 2h ago",
    reasonNote: "The agent said: “couldn’t decide if this is a doc, a decision, or a roadmap note — a human should place it.”",
  },
  {
    id: "u2", title: "Flaky test quarantine list",
    snippet: "Nine tests that failed intermittently across the last 40 CI runs, with failure rates and last-green links.",
    reason: "LOW CONFIDENCE", meta: "agent · session 77aa · 1d ago",
    reasonNote: "System couldn’t file it — best match “Docs / CI” scored 0.41, below the 0.7 threshold.",
  },
];

export const MOCK_ASSIGN: AssignOptions = {
  kinds: ["Doc section", "Decision record", "Roadmap note", "Feed update"],
  targets: {
    "Doc section": ["Runbooks / Deployment", "Architecture / Data layer", "Policies / Retry & Backoff", "Onboarding"],
    "Decision record": ["Decision log — file as new ADR draft"],
    "Roadmap note": ["Q3 — Reliability", "Q3 — Platform", "Backlog"],
    "Feed update": ["Team feed"],
  },
};

export const MOCK_IDENTITY: IdentityGroup[] = [
  {
    id: "g1", login: "mk-dev2", meta: "first seen 3w ago", countNum: 14, countLabel: "14 events waiting on this match",
    sample: [
      { kind: "PR", text: "#412 Fix pagination cursor drift in activity feed", when: "2d ago" },
      { kind: "COMMIT", text: "a41f9c — chore: bump redis client to 5.2", when: "4d ago" },
      { kind: "ISSUE", text: "#398 Export job OOMs on workspaces > 2GB", when: "1w ago" },
    ],
  },
  {
    id: "g2", login: "jonas-laptop", meta: "first seen 5d ago", countNum: 3, countLabel: "3 events waiting on this match",
    sample: [
      { kind: "COMMIT", text: "8c02de — wip: local docker compose for the relay", when: "2d ago" },
      { kind: "COMMIT", text: "f7a311 — fix: relay backoff config typo", when: "5d ago" },
    ],
  },
];

export const MOCK_PEOPLE: Person[] = [
  { id: "maya", name: "Maya Krishnan", initials: "MK" },
  { id: "jonas", name: "Jonas Weber", initials: "JW" },
  { id: "priya", name: "Priya Shah", initials: "PS" },
  { id: "tom", name: "Tom Ellis", initials: "TE" },
];
