-- Local dev seed for Phase-2 wiring verification. Apply AFTER migrations:
--   wrangler d1 migrations apply canopy --local
--   wrangler d1 execute canopy --local --file=scripts/seed-dev.sql
-- Uses ONLY the real controlled vocabulary (sections reference|context|decisions|needs-triage;
-- tags auth|architecture|infra|api|ui|data). The 'devsession' session id is forged into a
-- signed cookie by scripts/dev-cookie.mjs so gated routes can be exercised locally.

DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs;
DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage;
DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;
-- Reset AUTOINCREMENT counters so feed ids restart at 1 and the entry_tags
-- cross-references (entry_id '1'..'3') match the feed rows on every re-seed.
DELETE FROM sqlite_sequence;

INSERT INTO users (github_login, name, github_token, created_at) VALUES
  ('devuser', 'Dev User', NULL, '2026-06-01T00:00:00Z');
INSERT INTO sessions (id, user, created_at, expires_at) VALUES
  ('devsession', 'devuser', '2026-06-01T00:00:00Z', '2099-01-01T00:00:00Z');

-- Docs across all three browsable sections. mcp-server has a newer STAGED version (v3 > current 2)
-- so the Triage "Proposals" queue + the promote-doc DoD demo have real data.
INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES
  ('mcp-server','reference','MCP Server','The MCP server is the only write path into Canopy. Coding agents connect over the Model Context Protocol and post session output through a typed contract.',2,'2026-06-23T00:00:00Z','meilin'),
  ('product-overview','context','Product Overview','Canopy is the shared source of truth and working memory for Sapling, a four-person software team.',1,'2026-06-10T00:00:00Z','sanaok'),
  ('postgres-store','decisions','ADR-001 · Postgres for the store','Use a single Postgres instance as the store. Sections, versions, feed entries, and decisions are all rows.',1,'2026-06-02T00:00:00Z','sanaok');
INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by) VALUES
  ('mcp-server',1,'v1 body — initial page.','Initial page','promoted','high','2026-04-01T00:00:00Z','devraj'),
  ('mcp-server',2,'The MCP server is the only write path into Canopy. Coding agents connect over the Model Context Protocol and post session output through a typed contract.','Documented the typed contract','promoted','high','2026-06-23T00:00:00Z','meilin'),
  ('mcp-server',3,'The MCP server is the only write path. Tokens are compared in constant time. Rotation: revoke and re-mint from Settings.','Clarify token rotation and add constant-time note','staged','high','2026-06-24T00:00:00Z','meilin'),
  ('product-overview',1,'Canopy is the shared source of truth and working memory for Sapling, a four-person software team.','Initial page','promoted','high','2026-06-10T00:00:00Z','sanaok'),
  ('postgres-store',1,'Use a single Postgres instance as the store. Sections, versions, feed entries, and decisions are all rows.','Initial ADR','promoted','high','2026-06-02T00:00:00Z','sanaok');

-- Feed (artifacts as JSON matching the ingest contract: {prs, commits, issues}).
INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES
  ('meilin','Implemented Mermaid + D2 rendering in the Docs reader','Fenced mermaid and d2 blocks now render to inline SVG on the client, with the source block as a fallback.','{"prs":["145"],"commits":["7b1e004"],"issues":[]}','2026-06-25T11:30:00Z'),
  ('jose-a','Switched MCP token comparison to constant-time','Replaces the early-return string compare flagged in #138. Adds a timing test that fails on the old implementation.','{"prs":["142"],"commits":["a3f9c21"],"issues":[138]}','2026-06-25T10:00:00Z'),
  ('sanaok','Drafted ADR: append-only feed as the system of record',NULL,'{"prs":[],"commits":[],"issues":[150]}','2026-06-25T08:00:00Z');
INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES
  ('ui','feed','1'),('architecture','feed','1'),('auth','feed','2'),('architecture','feed','3'),('data','feed','3');

-- ADRs: one draft (Triage "Decisions" queue), one ratified.
INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by) VALUES
  ('Agent write contract','Agents post to Canopy at the end of a session over MCP. Without a fixed contract, writes arrived in inconsistent shapes.','Agents write through a typed contract; every write lands STAGED and unplaceable writes go to Triage.','Keeping every agent write non-destructive and staged preserves the human review gate.','draft','high','2026-06-24T00:00:00Z','devraj'),
  ('Single-accent color system','Early mocks used several accent colors and gray surfaces.','One electric-green accent with two tuned values; no gray surfaces.','A single accent keeps live and active state unambiguous.','ratified','high','2026-06-12T00:00:00Z','devraj');

-- needs_triage: two unresolved unplaced items (Triage "Triage" queue).
INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at) VALUES
  ('The MCP server should rate-limit per token. Proposed 60 writes/min burst, 600/hour sustained.','No clear section. Mixes a Reference description with an unmade Decision about limits.','jose-a',0,'2026-06-25T09:00:00Z'),
  ('Onboarding: 1) get added to the org, 2) sign in to Canopy, 3) mint an MCP token in Settings.','Ambiguous between Context (team process) and Reference (how-to). Needs a human to choose.','meilin',0,'2026-06-24T00:00:00Z');

-- Milestones: done / in_progress / upcoming; with and without github_ref (progress is null locally).
INSERT INTO milestones (title, description, target_date, status, github_ref, created_at, created_by, updated_at) VALUES
  ('MCP write contract — GA','Typed, staged-only writes for every agent over MCP.','2026-04-30','done','1','2026-03-01T00:00:00Z','sanaok','2026-04-30T00:00:00Z'),
  ('Token rotation & audit log','Constant-time comparison, revoke, and a read trail.','2026-06-10','in_progress','[160,162,175]','2026-05-01T00:00:00Z','jose-a',NULL),
  ('Semantic search ranking','Mixed feed/doc results ordered by meaning, not match.','2026-07-18','upcoming',NULL,'2026-06-01T00:00:00Z','meilin',NULL);

-- Milestone proposal (staged) for the Triage promote-proposal action.
INSERT INTO milestone_proposals (title, target_date, status, github_ref, change_summary, confidence, staged_status, created_at, created_by) VALUES
  ('Self-host & deploy guide','2026-09-20','upcoming',NULL,'Run the whole store on your own infrastructure.','high','staged','2026-06-25T00:00:00Z','devraj');
