// Generates scripts/seed-prod.sql from the structured content below, with proper SQL
// escaping. Run: node scripts/build-prod-seed.mjs  → then apply to remote D1.
// Content documents the REAL Canopy system (accurate to the codebase). One-time bootstrap
// of an empty prod store; re-running resets the content tables (safe ONLY before agents
// start writing real content via MCP).
import { writeFileSync } from "node:fs";

const AUTHOR = "AndresL230";
const NOW = "2026-06-25T20:00:00Z";

// ── Documentation library (section ∈ reference|context|decisions) ─────────────
// `body` is rendered as pre-wrap prose (the reader does not parse markdown), so write
// clean paragraphs separated by blank lines. `staged` adds a newer staged proposal so the
// Triage "Proposals" queue + the Docs "staged" banner have real content.
const docs = [
  // ── Reference ──────────────────────────────────────────────────────────────
  { slug: "mcp-server", section: "reference", title: "MCP Server", updated_at: "2026-06-24T10:00:00Z",
    body:
`The MCP server is the only write path into Canopy. Coding agents connect over the Model Context Protocol and post the output of a work session through a typed contract; nothing else can mutate the store.

The endpoint lives at /mcp on the same origin as everything else and is bearer-only. Each request carries a personal access token in the Authorization header (Bearer canopy_mcp_…). On a missing or invalid credential the server returns a bare 401 with no WWW-Authenticate header and no OAuth discovery — clients must use the configured token. The token is compared by SHA-256 hash against the store and never logged.

A fresh MCP server instance is constructed per request (the SDK guards against reuse), and the handler is stateless — there is no Durable Object or long-lived agent. The write tools (append_feed, propose_doc_update, propose_milestone) do not write directly: they funnel through the same gate as the HTTP /ingest path, so an agent can never bypass review.`,
    staged: { summary: "Document token rotation + the per-request server lifecycle",
      body:
`The MCP server is the only write path into Canopy. Coding agents connect over the Model Context Protocol and post the output of a work session through a typed contract; nothing else can mutate the store.

The endpoint lives at /mcp and is bearer-only: a personal token in the Authorization header (Bearer canopy_mcp_…), compared by SHA-256 hash, never logged. Bad credentials get a bare 401 — no WWW-Authenticate, no OAuth discovery.

Rotation: tokens never expire on their own. Revoke and mint a new one from Settings; the old value stops working immediately. A fresh, stateless server is built per request, and the write tools funnel through the same gate as /ingest — an agent can never bypass human review.` } },

  { slug: "the-gate", section: "reference", title: "The Gate — the single write surface", updated_at: "2026-06-23T09:00:00Z",
    body:
`Every write — from MCP and from the HTTP /ingest path alike — funnels through one set of per-entry gate functions. There is exactly one place that decides write-vs-stage-vs-triage, and adding a new write means adding it here rather than introducing a second surface.

The gate makes three guarantees. First, nothing is guessed: an out-of-vocabulary tag or section, a low-confidence flag, or a milestone marked done is routed to the needs-triage queue instead of being written blindly. Second, the author is always the authenticated principal passed in by the caller; the client-supplied author field is advisory and ignored. Third, agent writes are non-destructive — they land as staged proposals, never as live content.

This is the load-bearing invariant of the whole system: because there is a single gated path, the human review guarantee holds no matter which client is talking to Canopy.`},

  { slug: "auth", section: "reference", title: "Auth", updated_at: "2026-06-25T18:00:00Z",
    body:
`Sign-in is delegated to GitHub via OAuth with PKCE, and access is gated to active members of the SaplingLearn organization. After the OAuth exchange Canopy checks org membership; non-members are redirected to a locked dead-end (/?denied=1) and no session is created.

Humans authenticate with a signed session cookie. Agents authenticate to /mcp with a personal bearer token (canopy_mcp_… prefix), stored only as a SHA-256 hash. The principal — just a GitHub login — is resolved from the session for HTTP and from the bearer for /mcp, and is threaded into the gate as the authoritative author.

The org's OAuth token is retained at the callback, AES-GCM-sealed under the cookie secret (no separate secret), so the roadmap can read GitHub at view time. One subtlety worth knowing: GitHub only accepts https callback URLs for public hosts, so Canopy forces the redirect_uri scheme to https except on localhost — a request that reaches the Worker over http still produces an https callback that GitHub accepts.`},

  { slug: "data-model", section: "reference", title: "Data Model", updated_at: "2026-06-20T12:00:00Z",
    body:
`Canopy is a single Cloudflare D1 (SQLite) database. The first-class objects are docs, feed entries, decisions (ADRs), and milestones; everything else supports them.

A doc has exactly one promoted version live at a time (docs.current_version), with its full history in doc_versions — each version carries a status of staged or promoted, a change summary, a confidence flag, and an author. Promotion copies a staged version's body into the live doc and bumps current_version; prior versions are never destroyed. The feed table is an append-only log; tags live in entry_tags keyed by entry type and id. ADRs live in their own table with a draft/ratified status. needs_triage holds unplaceable items awaiting a human.

Identity tables (users, sessions, mcp_tokens) and the roadmap tables (milestones, milestone_proposals) round out the schema. The controlled vocabulary — the sections and tags the gate accepts — lives in its own tables and is the gate's source of truth.`},

  { slug: "feed", section: "reference", title: "Feed", updated_at: "2026-06-22T08:00:00Z",
    body:
`The Feed is the append-only log of everything the team and its agents have done. Entries are immutable: they are never edited or deleted, and a correction is a new entry that references the original. This makes the log auditable and matches how agents actually produce output — one entry per session, never revised after the fact.

Each entry has an author (a GitHub login), a one-line summary, an optional body, and artifacts — pull requests, commits, and issue numbers — stored as JSON and rendered as links. The feed can be filtered by author and by tag at read time. Tags are drawn from the controlled vocabulary, so the filter set is always meaningful.`},

  { slug: "docs-and-versioning", section: "reference", title: "Docs & Versioning", updated_at: "2026-06-21T11:00:00Z",
    body:
`Docs is the reading surface for promoted sections, grouped into Reference, Context, and Decisions. There is no editor on this site — pages are written by agents through the MCP contract and become live only after a human promotes them in Triage.

Versioning is non-destructive. An agent's propose_doc_update stages a new version; the live doc is untouched until a human runs promote, which copies the staged body into the doc and advances current_version. Every prior version remains readable through the version-history control, and a page that has a newer staged proposal shows a banner linking to Triage. Exactly one version is promoted (live) at any moment.`},

  { slug: "triage", section: "reference", title: "Triage — the human-confirm console", updated_at: "2026-06-19T15:00:00Z",
    body:
`Triage is where staged agent output becomes accepted truth. It is the human half of "agents stage, humans confirm," and it is deliberately not reachable over MCP — the confirm actions are session-cookie-authenticated HTTP routes, never agent-callable tools.

There are three queues. Proposals are staged doc versions newer than the live page; promoting one makes it the live version. Decisions are drafted ADRs; ratifying one flips it from draft to ratified. Triage proper holds needs-triage items — agent output the gate could not place — for a human to assign or discard. A staged proposal shows a real line-diff against the promoted version, so the reviewer can see exactly what changes before clicking Promote.`},

  { slug: "roadmap", section: "reference", title: "Roadmap", updated_at: "2026-06-18T10:00:00Z",
    body:
`The Roadmap is a timeline of coarse milestones — the altitude above individual GitHub issues. Each milestone has a title, a target date, and a status of upcoming, in progress, or done.

Progress is computed live from GitHub at view time and stored nowhere. A milestone's github_ref is a bare reference — a GitHub milestone number, or a JSON array of issue numbers — resolved against the configured repository using the viewer's stored OAuth token. If the token is absent, expired, or lacks access (for example a private repo read with only read:org scope), the milestone is returned without progress rather than as an error, and the bar renders as unavailable. Completion is never inferred from 100% issue closure: marking a milestone done is always a deliberate human confirm.`},

  { slug: "search", section: "reference", title: "Search", updated_at: "2026-06-17T14:00:00Z",
    body:
`Search spans docs, feed entries, and decisions in one ranked list. The current implementation is a straightforward text match in D1; the result shape — a type, a title, and a snippet — is fixed so that semantic ranking can be added later without changing the surface the reader sees.

A section filter narrows to docs only; without it, feed and ADR matches are included. The query is highlighted inside each snippet on the client.`},

  { slug: "routes-and-tools", section: "reference", title: "MCP Tools & HTTP Routes", updated_at: "2026-06-25T19:00:00Z",
    body:
`Reads (HTTP, session-gated): GET /feed, /docs, /doc/:slug, /search, /roadmap, /needs-triage, /adrs, /milestone-proposals, /auth/me.

Human confirms (HTTP, session-gated — never MCP tools): POST /doc/:slug/promote, /adr/:id/ratify, /milestone-proposals/:id/promote, /milestones/:id/complete.

Auth (HTTP): GET /auth/login and /auth/callback are public; POST /auth/logout and /auth/mcp-token are gated.

Agent writes (MCP tools at /mcp, bearer-only): append_feed, propose_doc_update, propose_milestone, plus the read tools get_doc, list_docs, get_feed, search_context, get_roadmap. Every write tool funnels through the gate — the same code path as /ingest.`},

  // ── Context ────────────────────────────────────────────────────────────────
  { slug: "product-overview", section: "context", title: "Product Overview", updated_at: "2026-06-15T09:00:00Z",
    body:
`Canopy is the shared source of truth and working memory for the Sapling team. It is read by humans and written almost entirely by their coding agents: at the end of a session an agent posts what it did and what it proposes, and a human confirms the consequential changes.

It runs as a single Cloudflare Worker on one origin that serves the HTTP API, a stateless MCP endpoint, and the static web app together. The guiding idea is that a small team plus its agents stays coherent if there is exactly one gated way to write and a fast console for a human to confirm. Everything else — the immutable feed, the promoted-vs-staged doc model, the live roadmap — follows from that.`},

  { slug: "team-roles", section: "context", title: "Team & Roles", updated_at: "2026-06-14T09:00:00Z",
    body:
`Authorship in Canopy follows the GitHub identity of whoever ran the session that produced a change — the gate stamps the authenticated principal as the author and ignores any client-supplied name. Access is limited to active members of the SaplingLearn organization.

There are two roles in practice, not two kinds of people: an agent stages, and a human confirms. The same person can do both — point an agent at the MCP endpoint to write, then sign in to Triage to promote.`},

  { slug: "glossary", section: "context", title: "Glossary", updated_at: "2026-06-25T16:00:00Z",
    body:
`promoted — the live, canonical version of a doc that humans read. Exactly one exists per doc at a time.

staged — an agent-proposed change awaiting human review in Triage. Not yet visible as the live page.

ratified / draft — the same distinction for decisions (ADRs): a draft is proposed, a ratified ADR is accepted.

principal — the authenticated identity ({ login }) resolved from the session (HTTP) or bearer (MCP); the gate uses it as the author.

the gate — the single set of functions every write passes through, deciding write-vs-stage-vs-triage.

needs-triage — the catch-all for agent output that could not be placed automatically and is waiting on a human.`},

  { slug: "deployment", section: "context", title: "How Canopy is Deployed", updated_at: "2026-06-25T20:00:00Z",
    body:
`Canopy is a single Cloudflare Worker named canopy, deployed from the main branch via Cloudflare Workers Builds (build command npm run build:web, deploy command wrangler deploy). The web app is built by Vite into web/dist and served by the Worker's ASSETS binding, on the same origin as the API.

State is one D1 database, also named canopy, bound as DB; its schema and controlled vocabulary come from the migrations in migrations/, applied to the remote database once. Three secrets configure the runtime: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from the GitHub OAuth app, and COOKIE_SECRET (which also seals the stored org token). The public origin is canopy.saplinglearn.com; the GitHub OAuth app's callback is that origin's /auth/callback over https.`},

  // ── Decisions (ADRs published as docs) ───────────────────────────────────────
  { slug: "adr-001-single-write-path", section: "decisions", title: "ADR-001 · One gated write path", updated_at: "2026-04-10T09:00:00Z",
    body:
`Context: agents produce output in many shapes, and without a single chokepoint, writes arrived inconsistently and some bypassed review entirely.

Decision: every write — MCP tools and the HTTP ingest path alike — funnels through one set of per-entry gate functions. Adding a new write means extending the gate, never introducing a second write surface.

Rationale: a single gated path is what makes the human-review guarantee hold regardless of client. It is the load-bearing invariant; everything else in Canopy depends on it being true.`},

  { slug: "adr-002-staged-writes", section: "decisions", title: "ADR-002 · Agents stage, humans confirm", updated_at: "2026-04-18T09:00:00Z",
    body:
`Context: letting agents write directly to live content would make the store fast to fill and impossible to trust.

Decision: agents only ever stage. Live changes happen exclusively through authenticated HTTP routes that are never exposed as MCP tools — promote a doc version, ratify an ADR, promote a milestone proposal, complete a milestone. Promotion is non-destructive; prior versions remain.

Rationale: keeping every agent write non-destructive and staged preserves a human review gate without slowing agents down, and the confidence flag on each write lets reviewers triage quickly.`},

  { slug: "adr-003-org-gate", section: "decisions", title: "ADR-003 · GitHub OAuth, gated to the org", updated_at: "2026-05-02T09:00:00Z",
    body:
`Context: Canopy holds a team's working memory and must not be world-readable, but the team did not want to run a separate identity system.

Decision: delegate sign-in to GitHub via OAuth with PKCE, and gate access to active members of the SaplingLearn organization. Humans get a signed session cookie; agents get hashed per-person bearer tokens for /mcp. Non-members hit a locked dead-end.

Rationale: the team already lives in GitHub, so org membership is the natural access boundary and requires no new credential store. The org's OAuth token is sealed at rest and reused for live roadmap reads.`},

  { slug: "adr-004-live-roadmap", section: "decisions", title: "ADR-004 · Roadmap progress is computed live, stored nowhere", updated_at: "2026-05-20T09:00:00Z",
    body:
`Context: a roadmap whose progress is copied into the store drifts from reality the moment an issue closes.

Decision: store only the milestones (title, target, status, a bare github_ref). Compute closed/total from GitHub at read time and never persist it. If the token can't read GitHub, return the milestone without progress rather than an error. Marking a milestone done stays a deliberate human action — never inferred from 100% closure.

Rationale: observed data can't go stale. The roadmap is the first feature built entirely on read-time data, and it degrades gracefully when GitHub is unavailable.`},

  { slug: "adr-005-single-accent", section: "decisions", title: "ADR-005 · Single-accent design system", updated_at: "2026-05-28T09:00:00Z",
    body:
`Context: early mocks used several accent colors and gray surfaces; state badges blurred together and the tool felt generic.

Decision: one electric-green accent with two tuned values (bright on black, deepened on white), pure black/white backgrounds, and no gray surfaces — separation comes from hairline borders and opacity. State is carried by a fixed small badge palette.

Rationale: a single accent keeps live and active state unambiguous and the interface stark and fast to scan, which suits a reference tool the team checks constantly.`},
];

// ── Roadmap milestones (no github_ref: repo is private + has no issues; progress null) ──
const milestones = [
  { title: "MCP write contract — GA", description: "Typed, staged-only writes for every agent over MCP, all funneling through the gate.", target_date: "2026-04-30", status: "done" },
  { title: "Triage review console", description: "The human-confirm half: proposals, decisions, and unplaced items in one console with a real diff.", target_date: "2026-05-22", status: "done" },
  { title: "GitHub OAuth org gate", description: "Sign-in delegated to GitHub, access gated to active SaplingLearn members; hashed MCP bearers.", target_date: "2026-05-30", status: "done" },
  { title: "Frontend wired to real data", description: "Every screen renders real @shared shapes from D1 over one origin; no mock data remains.", target_date: "2026-06-25", status: "done" },
  { title: "Roadmap + live GitHub progress", description: "Milestones read closed/total straight from GitHub at view time — stored nowhere. Needs repo-readable token.", target_date: "2026-07-10", status: "in_progress" },
  { title: "Semantic search ranking", description: "Embeddings over docs and feed so results rank by meaning, behind the existing fixed result shape.", target_date: "2026-08-01", status: "upcoming" },
  { title: "Multi-agent session attribution", description: "Per-session identity across parallel agent runs, so every write says which agent and session produced it.", target_date: "2026-08-28", status: "upcoming" },
  { title: "Self-host & deploy guide", description: "A documented path to run Canopy and its MCP server on your own infrastructure.", target_date: "2026-09-20", status: "upcoming" },
];

// ── A little cross-screen content so Feed / Triage aren't empty ───────────────
const feed = [
  { author: AUTHOR, summary: "Deployed Canopy to canopy.saplinglearn.com", body: "First production deploy: one Worker, D1 bound, custom domain live, GitHub OAuth wired to the SaplingLearn org.", tags: ["infra", "auth"], created_at: "2026-06-25T19:30:00Z" },
  { author: AUTHOR, summary: "Wired the whole frontend to real routes (Phase 2)", body: "Feed, Docs, Search, Roadmap, Triage, and Settings now render real D1 data; the mock layer is gone.", tags: ["ui", "api"], created_at: "2026-06-25T17:00:00Z" },
  { author: AUTHOR, summary: "Forced https in the OAuth redirect_uri", body: "GitHub rejects http callbacks for public hosts; the Worker now always emits an https redirect_uri except on localhost.", tags: ["auth"], created_at: "2026-06-25T18:30:00Z" },
  { author: AUTHOR, summary: "Seeded the documentation library and roadmap", body: "Bootstrapped the store with a detailed reference/context/decisions library and the milestone timeline.", tags: ["data"], created_at: "2026-06-25T20:00:00Z" },
];

const adrs = [ // drafts → Triage "Decisions" queue
  { title: "Add the repo scope for private-repo roadmap progress", context: "The roadmap reads GitHub issues with read:org read:user, which cannot see a private repo's issues, so progress is always unavailable for SaplingLearn/canopy.", decision: "Request the repo scope at OAuth time so the stored token can read the private repo's issues and milestones, enabling live progress.", rationale: "It is the smallest change that makes live progress work without making the repo public; the token is already sealed at rest.", author: AUTHOR, created_at: "2026-06-25T20:05:00Z" },
  { title: "Rate-limit the MCP endpoint per token", context: "Nothing currently bounds how fast an agent can write over /mcp.", decision: "Add a per-token rate limit (proposed: 60 writes/min burst, 600/hour sustained) enforced at the boundary.", rationale: "Protects the store and the gate from a runaway agent without affecting normal session-end writes.", author: AUTHOR, created_at: "2026-06-25T20:06:00Z" },
];

const triage = [ // needs_triage → Triage "Triage" queue
  { raw: "Should agent feed entries support threading (replies that reference a prior entry), or stay a flat append-only log? Affects the data model and the feed UI.", reason: "Mixes a Reference description with an unmade Decision; needs a human to choose before it lands anywhere.", source_author: AUTHOR, created_at: "2026-06-25T20:10:00Z" },
];

// ── Emit SQL ──────────────────────────────────────────────────────────────────
const q = (v) => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const lines = [];
lines.push("-- GENERATED by scripts/build-prod-seed.mjs — do not hand-edit; edit the generator.");
lines.push("-- One-time bootstrap of the production Canopy store. Resets content tables first");
lines.push("-- (safe ONLY before agents start writing real content via MCP).");
lines.push("DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs;");
lines.push("DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage;");
lines.push("DELETE FROM sqlite_sequence;");
lines.push("");

for (const d of docs) {
  const currentVersion = d.staged ? 1 : 1; // promoted v1 is current; staged (if any) is v2
  lines.push(`INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by, space) VALUES (${q(d.slug)}, ${q(d.section)}, ${q(d.title)}, ${q(d.body)}, 1, ${q(d.updated_at)}, ${q(AUTHOR)}, 'canopy');`);
  lines.push(`INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by) VALUES (${q(d.slug)}, 1, ${q(d.body)}, ${q("Initial published version")}, 'promoted', 'high', ${q(d.updated_at)}, ${q(AUTHOR)});`);
  if (d.staged) {
    lines.push(`INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by) VALUES (${q(d.slug)}, 2, ${q(d.staged.body)}, ${q(d.staged.summary)}, 'staged', 'high', ${q(NOW)}, ${q(AUTHOR)});`);
  }
}
lines.push("");
for (const m of milestones) {
  lines.push(`INSERT INTO milestones (title, description, target_date, status, github_ref, created_at, created_by, updated_at) VALUES (${q(m.title)}, ${q(m.description)}, ${q(m.target_date)}, ${q(m.status)}, NULL, ${q(NOW)}, ${q(AUTHOR)}, ${q(NOW)});`);
}
lines.push("");
feed.forEach((f, i) => {
  const id = i + 1;
  lines.push(`INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (${q(f.author)}, ${q(f.summary)}, ${q(f.body)}, NULL, ${q(f.created_at)});`);
  for (const t of f.tags) lines.push(`INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES (${q(t)}, 'feed', ${q(String(id))});`);
});
lines.push("");
for (const a of adrs) {
  lines.push(`INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by) VALUES (${q(a.title)}, ${q(a.context)}, ${q(a.decision)}, ${q(a.rationale)}, 'draft', 'high', ${q(a.created_at)}, ${q(a.author)});`);
}
lines.push("");
for (const t of triage) {
  lines.push(`INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at) VALUES (${q(t.raw)}, ${q(t.reason)}, ${q(t.source_author)}, 0, ${q(t.created_at)});`);
}
lines.push("");

writeFileSync(new URL("./seed-prod.sql", import.meta.url), lines.join("\n"));
console.log(`Wrote seed-prod.sql: ${docs.length} docs, ${milestones.length} milestones, ${feed.length} feed, ${adrs.length} ADR drafts, ${triage.length} triage`);
