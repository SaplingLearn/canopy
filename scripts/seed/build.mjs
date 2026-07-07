import { RESET_STATEMENTS } from "./reset.mjs";

// SQL string literal: wrap in single quotes, double any embedded quote. NULL for
// null/undefined. JSON.stringify guarantees no literal newlines in embedded JSON.
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? "NULL" : String(Number(v)));
const jsonLit = (obj) => (obj === null || obj === undefined ? "NULL" : q(JSON.stringify(obj)));

// Provenance stamped on structured summary rows so they read as "done" (My Work's
// Sync skip-check treats a row as generated only when model != 'excerpt' AND
// title IS NOT NULL). Matches WORKERS_AI_MODEL in src/tools/summarize.ts.
const STRUCTURED_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** True iff the loader was asked to touch remote D1 — the loader must refuse. */
export const targetsRemote = (argv) => argv.includes("--remote");

/**
 * Turn parsed fixture objects into standalone, escaped SQL statements (no
 * trailing ";"), reset statements first. FK-safe ordering: events before
 * pr_summaries, milestones before milestone_progress.
 */
export function buildSeedStatements(fx) {
  const s = [...RESET_STATEMENTS];

  for (const d of fx.docs?.docs ?? []) {
    s.push(
      `INSERT INTO docs (slug, section, space, title, body, current_version, updated_at, updated_by) VALUES (` +
        `${q(d.slug)}, ${q(d.section)}, ${q(d.space ?? "canopy")}, ${q(d.title)}, ${q(d.body)}, ${num(d.current_version)}, ${q(d.updated_at)}, ${q(d.updated_by)})`
    );
    for (const v of d.versions ?? []) {
      s.push(
        `INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by, change_kind, base_version, low_confidence) VALUES (` +
          `${q(d.slug)}, ${num(v.version)}, ${q(v.body)}, ${q(v.summary)}, ${q(v.status)}, ${q(v.confidence)}, ${q(v.created_at)}, ${q(v.created_by)}, ${q(v.change_kind)}, ${num(v.base_version)}, ${num(v.low_confidence ?? 0)})`
      );
    }
  }

  for (const f of fx.feed?.feed ?? []) {
    s.push(
      `INSERT INTO feed (id, author, summary, body, artifacts, created_at) VALUES (` +
        `${num(f.id)}, ${q(f.author)}, ${q(f.summary)}, ${q(f.body)}, ${jsonLit(f.artifacts)}, ${q(f.created_at)})`
    );
    for (const t of f.tags ?? []) {
      s.push(`INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES (${q(t)}, 'feed', ${q(String(f.id))})`);
    }
  }

  for (const a of fx.adrs?.adrs ?? []) {
    s.push(
      `INSERT INTO adrs (id, title, context, decision, rationale, status, confidence, created_at, created_by) VALUES (` +
        `${num(a.id)}, ${q(a.title)}, ${q(a.context)}, ${q(a.decision)}, ${q(a.rationale)}, ${q(a.status)}, ${q(a.confidence)}, ${q(a.created_at)}, ${q(a.created_by)})`
    );
  }

  for (const t of fx.triage?.needs_triage ?? []) {
    s.push(
      `INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at) VALUES (` +
        `${q(t.raw)}, ${q(t.reason)}, ${q(t.source_author)}, ${num(t.resolved ?? 0)}, ${q(t.created_at)})`
    );
  }

  for (const m of fx.triage?.milestone_proposals ?? []) {
    s.push(
      `INSERT INTO milestone_proposals (title, target_date, status, github_ref, change_summary, confidence, staged_status, created_at, created_by) VALUES (` +
        `${q(m.title)}, ${q(m.target_date)}, ${q(m.status)}, ${q(m.github_ref)}, ${q(m.change_summary)}, ${q(m.confidence)}, ${q(m.staged_status ?? "staged")}, ${q(m.created_at)}, ${q(m.created_by)})`
    );
  }

  const rm = fx.roadmap;
  if (rm) {
    s.push(
      `UPDATE plan SET narrative = ${q(rm.narrative)}, current_version = ${num(rm.version)}, updated_at = ${q(rm.updated_at)}, updated_by = ${q(rm.updated_by)} WHERE id = 1`
    );
    s.push(
      `INSERT INTO plan_versions (version, narrative, milestones_json, created_at, created_by) VALUES (` +
        `${num(rm.version)}, ${q(rm.narrative)}, ${jsonLit(rm.milestones ?? [])}, ${q(rm.updated_at)}, ${q(rm.updated_by)})`
    );
    for (const m of rm.milestones ?? []) {
      s.push(
        `INSERT INTO milestones (id, title, description, phase, target_date, status, github_ref, created_at, created_by, updated_at) VALUES (` +
          `${num(m.id)}, ${q(m.title)}, ${q(m.description)}, ${q(m.phase)}, ${q(m.target_date)}, ${q(m.status)}, ${q(m.github_ref)}, ${q(m.created_at)}, ${q(m.created_by)}, ${q(m.updated_at)})`
      );
      if (m.progress) {
        s.push(
          `INSERT INTO milestone_progress (milestone_id, closed, total, source, computed_at) VALUES (` +
            `${num(m.id)}, ${num(m.progress.closed)}, ${num(m.progress.total)}, ${q(m.progress.source ?? "recompute")}, ${q(m.progress.computed_at)})`
        );
      }
    }
  }

  for (const e of fx.events?.events ?? []) {
    s.push(
      `INSERT INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by) VALUES (` +
        `${q(e.semantic_key)}, ${q(e.event_type)}, ${num(e.ref_number)}, ${q(e.subject_login)}, ${jsonLit(e.raw)}, ${q(e.provenance ?? "backfill")}, ${q(e.occurred_at)}, ${q(e.recorded_at)}, ${q(e.recorded_by ?? "github-webhook")})`
    );
    // Structured summaries (0018): fixtures carry an object; `summary` (the NOT
    // NULL prose mirror) is `what`/`summary`, and title/what/why/impact | next_step
    // land in their own columns. A bare `model:"excerpt"` fixture stays prose-only.
    if (e.pr_summary) {
      const p = e.pr_summary;
      const model = p.model ?? STRUCTURED_MODEL;
      s.push(
        `INSERT INTO pr_summaries (semantic_key, pr_number, summary, model, created_at, title, what, why, impact) VALUES (` +
          `${q(e.semantic_key)}, ${num(e.ref_number)}, ${q(p.what)}, ${q(model)}, ${q(e.recorded_at)}, ${q(p.title)}, ${q(p.what)}, ${q(p.why)}, ${q(p.impact)})`
      );
    }
    if (e.issue_summary) {
      const i = e.issue_summary;
      const model = i.model ?? STRUCTURED_MODEL;
      s.push(
        `INSERT INTO issue_summaries (issue_number, summary, model, created_at, title, next_step) VALUES (` +
          `${num(e.ref_number)}, ${q(i.summary)}, ${q(model)}, ${q(e.recorded_at)}, ${q(i.title)}, ${q(i.next_step)})`
      );
    }
  }

  for (const t of fx.identity?.identity_tasks ?? []) {
    s.push(
      `INSERT INTO identity_tasks (login, first_seen, status, resolved_at, resolved_by) VALUES (` +
        `${q(t.login)}, ${q(t.first_seen)}, ${q(t.status ?? "pending")}, ${q(t.resolved_at)}, ${q(t.resolved_by)})`
    );
  }

  return s;
}
