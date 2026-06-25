// Phase 1 mock data — hardcoded, contract-free. Shapes mirror the design's
// `data-dc-script` block so Phase 2 can swap these for real `@shared` types as a
// find-and-replace. DO NOT import @shared here (keeping this phase contract-free
// is what makes the look reviewable in isolation).

export type PersonKey = "jose" | "mei" | "dev" | "sana";

export interface Person {
  login: string;
  full: string;
  display: string;
  initials: string;
}

export const people: Record<PersonKey, Person> = {
  jose: { login: "jose-a", full: "Jose Alvarez", display: "Jose", initials: "JA" },
  mei: { login: "meilin", full: "Mei Lin", display: "Mei", initials: "ML" },
  dev: { login: "dev-raj", full: "Devraj Patel", display: "Dev", initials: "DP" },
  sana: { login: "sanaok", full: "Sana Okonkwo", display: "Sana", initials: "SO" },
};

export interface Artifact {
  kind: string;
  label: string;
  href: string;
}

export interface FeedEntry {
  id: string;
  who: PersonKey;
  summary: string;
  body: string;
  tags: string[];
  time: string;
  artifacts: Artifact[];
}

export const feed: FeedEntry[] = [
  { id: "f1", who: "mei", summary: "Implemented Mermaid + D2 rendering in the Docs reader", body: "Fenced ```mermaid and ```d2 blocks now render to inline SVG on the client, with the source code block as a fallback when parsing fails.", tags: ["frontend", "docs"], time: "32m ago", artifacts: [{ kind: "PR", label: "#145", href: "https://github.com/sapling-dev/canopy/pull/145" }, { kind: "commit", label: "7b1e004", href: "https://github.com/sapling-dev/canopy/commit/7b1e004" }] },
  { id: "f2", who: "jose", summary: "Switched MCP token comparison to constant-time", body: "Replaces the early-return string compare flagged in #138. Adds a timing test that fails on the old implementation.", tags: ["mcp-server", "security"], time: "1h ago", artifacts: [{ kind: "PR", label: "#142", href: "https://github.com/sapling-dev/canopy/pull/142" }, { kind: "commit", label: "a3f9c21", href: "https://github.com/sapling-dev/canopy/commit/a3f9c21" }, { kind: "issue", label: "#138", href: "https://github.com/sapling-dev/canopy/issues/138" }] },
  { id: "f3", who: "sana", summary: "Drafted ADR: append-only feed as the system of record", body: "", tags: ["decisions", "architecture"], time: "3h ago", artifacts: [{ kind: "issue", label: "#150", href: "https://github.com/sapling-dev/canopy/issues/150" }] },
  { id: "f4", who: "dev", summary: "Promoted Reference / Auth after review", body: "", tags: ["docs", "auth"], time: "5h ago", artifacts: [] },
  { id: "f5", who: "mei", summary: "Indexed 1,204 store sections for search", body: "", tags: ["search", "infra"], time: "Yesterday", artifacts: [{ kind: "commit", label: "4c0aa11", href: "https://github.com/sapling-dev/canopy/commit/4c0aa11" }] },
  { id: "f6", who: "jose", summary: "Wired GitHub org-membership check into sign-in", body: "Non-members now hit the locked dead-end instead of a blank app shell.", tags: ["auth", "security"], time: "Yesterday", artifacts: [{ kind: "PR", label: "#139", href: "https://github.com/sapling-dev/canopy/pull/139" }, { kind: "commit", label: "9de0b2f", href: "https://github.com/sapling-dev/canopy/commit/9de0b2f" }] },
  { id: "f7", who: "dev", summary: "Added last-used tracking to MCP access tokens", body: "", tags: ["mcp-server", "settings"], time: "2d ago", artifacts: [{ kind: "PR", label: "#141", href: "https://github.com/sapling-dev/canopy/pull/141" }] },
  { id: "f8", who: "sana", summary: "Promoted Context / Glossary v3", body: "", tags: ["docs"], time: "2d ago", artifacts: [] },
];

export type DiffKind = "ctx" | "add" | "del";
export interface DiffLine {
  t: DiffKind;
  text: string;
}

export interface Proposal {
  id: string;
  section: string;
  title: string;
  summary: string;
  who: PersonKey;
  confidence: "High" | "Medium" | "Low";
  diff: DiffLine[];
}

export const initProposals: Proposal[] = [
  { id: "p1", section: "Reference", title: "MCP Server", summary: "Clarify token rotation and add the constant-time comparison note", who: "mei", confidence: "High",
    diff: [{ t: "ctx", text: "## Authentication" }, { t: "ctx", text: "" }, { t: "ctx", text: "Every MCP request carries a bearer token in the" }, { t: "del", text: "`Authorization` header. Tokens are matched against the store." }, { t: "add", text: "`Authorization` header. Tokens are compared in **constant time**" }, { t: "add", text: "to avoid timing side-channels, then matched against the store." }, { t: "ctx", text: "" }, { t: "add", text: "### Rotation" }, { t: "add", text: "" }, { t: "add", text: "Tokens never expire automatically. Revoke and re-mint from" }, { t: "add", text: "Settings to rotate; the old value stops working immediately." }] },
  { id: "p2", section: "Reference", title: "Auth", summary: "Document the non-member locked dead-end behavior", who: "jose", confidence: "Medium",
    diff: [{ t: "ctx", text: "## Sign-in" }, { t: "ctx", text: "" }, { t: "ctx", text: "Sign-in is delegated to GitHub OAuth." }, { t: "add", text: "" }, { t: "add", text: "After OAuth, membership in the `sapling-dev` org is checked." }, { t: "add", text: "Non-members are routed to a locked dead-end with no app" }, { t: "add", text: "behind it; they can only sign out and switch account." }] },
  { id: "p3", section: "Context", title: "Glossary", summary: "Define 'promoted' vs 'staged' and 'ratified' vs 'draft'", who: "sana", confidence: "High",
    diff: [{ t: "ctx", text: "# Glossary" }, { t: "ctx", text: "" }, { t: "add", text: "**promoted** — the live, canonical version of a section that" }, { t: "add", text: "humans read. Only one promoted version exists at a time." }, { t: "add", text: "" }, { t: "add", text: "**staged** — an agent-proposed change awaiting human review" }, { t: "add", text: "in Triage. Not yet visible in Docs." }, { t: "del", text: "**version** — any saved copy of a section." }] },
];

export interface Decision {
  id: string;
  idLabel: string;
  title: string;
  who: PersonKey;
  badge: string;
  context: string;
  decision: string;
  rationale: string;
}

export const initDecisions: Decision[] = [
  { id: "d1", idLabel: "ADR-003", title: "Agent write contract", who: "dev", badge: "DRAFT",
    context: "Agents post to Canopy at the end of a work session over MCP. Without a fixed contract, writes landed in inconsistent shapes and some could not be placed into a section.",
    decision: "Agents must write through a typed contract: every write targets a known section key, carries a change summary and a confidence flag, and lands as STAGED — never directly promoted. Unplaceable writes go to the Triage queue.",
    rationale: "Keeping every agent write non-destructive and staged preserves the human review gate that the whole system depends on, while the confidence flag lets reviewers triage fast." },
  { id: "d2", idLabel: "ADR-004", title: "Append-only feed as system of record", who: "sana", badge: "DRAFT",
    context: "The team needed a reliable working memory of what happened, but edits and deletes made earlier tools untrustworthy over time.",
    decision: "The Feed is append-only and immutable. Entries are never edited or deleted; corrections are new entries that reference the original.",
    rationale: "An immutable log is auditable and trustworthy, and it matches how agents actually produce output — one entry per session, never revised after the fact." },
];

export interface TriageItem {
  id: string;
  title: string;
  who: PersonKey;
  reason: string;
  raw: string;
}

export const initTriage: TriageItem[] = [
  { id: "t1", title: "Rate-limiting strategy for the MCP endpoint", who: "jose", reason: "No clear section. The content mixes a Reference description with an unmade Decision about limits.",
    raw: "The MCP server should rate-limit per token. Proposed: 60 writes/min burst, 600/hour sustained. Open question: do we 429 or queue? This affects the agent contract and probably needs an ADR before it lands in Reference." },
  { id: "t2", title: "New-member onboarding checklist", who: "mei", reason: "Ambiguous between Context (team process) and Reference (how-to). Needs a human to choose.",
    raw: "Onboarding: 1) get added to sapling-dev org, 2) sign in to Canopy, 3) mint an MCP token in Settings, 4) point your agent at the MCP URL, 5) read Reference / Data Model first." },
];

export interface RoadmapPhase {
  h: string;
  p: string;
}

export interface RoadmapDoc {
  section: string;
  title: string;
  updatedBy: PersonKey;
  at: string;
  staged: boolean;
  ver: string;
  lede: string;
  phases: RoadmapPhase[];
}

export const roadmapDoc: RoadmapDoc = {
  section: "Context", title: "Where Sapling is going", updatedBy: "sana", at: "3 days ago", staged: true, ver: "v5",
  lede: "Canopy is the high view over everything the team grows in Sapling. The plan below is our shared direction for the next two quarters — the load-bearing bets, in roughly the order we expect to make them. It is written by agents and promoted through Triage, so it stays honest about what is actually in flight.",
  phases: [
    { h: "Now — harden the write path", p: "The MCP contract and the Triage console are live, so every agent write is staged and reviewed. The work that remains is making that path boring: constant-time tokens, an audit trail, and a docs handbook complete enough that a new agent can onboard from Reference alone." },
    { h: "Next — make the store answer questions", p: "Once the handbook is whole, the leverage moves to retrieval. Semantic ranking over feed and docs turns Canopy from a place you browse into a place you ask. The Roadmap view itself — reading milestone progress straight from GitHub — is the first feature built entirely on observed, not stored, data." },
    { h: "Later — many agents, one memory", p: "As more agents run in parallel, attribution and conflict become the hard problem. The bet is that a single immutable feed plus per-session identity scales further than per-agent stores, and that self-hosting the whole thing keeps a small team in control of its own working memory." },
  ],
};

export type MilestoneStatus = "done" | "in-progress" | "upcoming";
export interface MilestoneIssue {
  n: number;
  closed: boolean;
  title: string;
}
export interface Milestone {
  id: string;
  title: string;
  desc: string;
  target: string;
  status: MilestoneStatus;
  about: string;
  gh: string;
  issues: MilestoneIssue[];
}

export const milestones: Milestone[] = [
  { id: "m1", title: "MCP write contract — GA", desc: "Typed, staged-only writes for every agent over MCP.", target: "2026-04-30", status: "done",
    about: "The foundation everything else stands on: a single, typed path for agents to write into the store. Each write names a known section, carries a change summary and confidence flag, and lands as STAGED — so no agent output reaches readers without passing through Triage.",
    gh: "milestone/1",
    issues: [{ n: 101, closed: true, title: "Define the write_section schema" }, { n: 104, closed: true, title: "Reject writes to unknown section keys" }, { n: 108, closed: true, title: "Stage-only enforcement at the boundary" }, { n: 112, closed: true, title: "Confidence flag on every write" }, { n: 115, closed: true, title: "Route unplaceable writes to Triage" }, { n: 119, closed: true, title: "append_feed contract" }, { n: 122, closed: true, title: "propose_decision contract" }, { n: 127, closed: true, title: "Contract conformance test suite" }] },
  { id: "m2", title: "Triage review console v1", desc: "Proposals, decisions, and unplaced items in one queue.", target: "2026-05-22", status: "done",
    about: "The human gate made usable. Three switchable queues — proposals, drafted decisions, and unplaced items — each with a fast diff and a one-gesture decision, so the review discipline holds without becoming a chore.",
    gh: "milestone/2",
    issues: [{ n: 130, closed: true, title: "Side-by-side proposal diff" }, { n: 131, closed: true, title: "Promote action + optimistic update" }, { n: 133, closed: true, title: "Decision ratify flow" }, { n: 136, closed: true, title: "Unplaced-item assign / discard" }, { n: 140, closed: true, title: "Pending counts per queue" }, { n: 143, closed: true, title: "Keyboard navigation" }, { n: 146, closed: true, title: "Confidence flag surfacing" }, { n: 149, closed: true, title: "Empty + loading states" }, { n: 151, closed: true, title: "Author identity on every item" }, { n: 154, closed: true, title: "Diff add/del line counts" }, { n: 158, closed: true, title: "Queue switch perf" }] },
  { id: "m3", title: "Token rotation & audit log", desc: "Constant-time comparison, revoke, and a read trail.", target: "2026-06-10", status: "in-progress",
    about: "Hardening the credential path. Tokens compare in constant time, can be revoked instantly, and every read is written to an append-only audit trail. The last open issue is the retention policy for that trail.",
    gh: "milestone/3",
    issues: [{ n: 160, closed: true, title: "Constant-time token comparison" }, { n: 162, closed: true, title: "Revoke endpoint + immediate effect" }, { n: 165, closed: true, title: "last-used timestamp tracking" }, { n: 168, closed: true, title: "Append-only read audit log" }, { n: 171, closed: true, title: "Audit log query API" }, { n: 175, closed: false, title: "Audit retention + compaction policy" }] },
  { id: "m4", title: "Docs handbook + diagram rendering", desc: "A browsable chapter per system part, Mermaid/D2 inline.", target: "2026-06-28", status: "in-progress",
    about: "Turning the reference into a real handbook. A page per part of the system, grouped into Reference / Context / Decisions, with Mermaid and D2 fenced blocks rendered as actual diagrams. All linked issues are closed — it is ready to promote to done.",
    gh: "milestone/4",
    issues: [{ n: 178, closed: true, title: "Section nav tree (3 fixed groups)" }, { n: 180, closed: true, title: "Markdown reader styling" }, { n: 182, closed: true, title: "Mermaid client-side render" }, { n: 184, closed: true, title: "D2 client-side render" }, { n: 186, closed: true, title: "Diagram source fallback on parse fail" }, { n: 188, closed: true, title: "Version-history control" }, { n: 190, closed: true, title: "Staged-proposal banner" }, { n: 193, closed: true, title: "Decision Context/Decision/Rationale layout" }, { n: 196, closed: true, title: "Per-part page scaffolding" }] },
  { id: "m5", title: "Semantic search ranking", desc: "Mixed feed/doc results ordered by meaning, not match.", target: "2026-07-18", status: "in-progress",
    about: "Making the store answer questions. Embeddings over feed entries and docs let results rank by meaning rather than literal match, while the existing result layout stays put so the upgrade is invisible to readers.",
    gh: "milestone/5",
    issues: [{ n: 200, closed: true, title: "Embedding pipeline for sections" }, { n: 203, closed: true, title: "Vector index + nightly refresh" }, { n: 206, closed: true, title: "Hybrid lexical + semantic scoring" }, { n: 209, closed: false, title: "Query-time re-ranker" }, { n: 212, closed: false, title: "Snippet selection around match" }, { n: 215, closed: false, title: "Type / section / author filters" }, { n: 218, closed: false, title: "Relevance eval harness" }, { n: 221, closed: false, title: "Latency budget < 150ms" }] },
  { id: "m6", title: "Roadmap + live GitHub progress", desc: "Milestones read straight from GitHub at view time.", target: "2026-08-05", status: "upcoming",
    about: "This very view. Milestones are coarse goals whose progress is observed from GitHub at read time — never stored — so the roadmap can never drift from reality. Completion stays a deliberate human confirm.",
    gh: "milestone/6",
    issues: [{ n: 224, closed: true, title: "GitHub milestone + issue read API" }, { n: 227, closed: false, title: "Progress bar from closed/total" }, { n: 230, closed: false, title: "Overdue + next-up detection" }, { n: 233, closed: false, title: "Ready-to-complete confirm gesture" }, { n: 236, closed: false, title: "Narrative / Timeline split" }, { n: 239, closed: false, title: "Cache + rate-limit handling" }] },
  { id: "m7", title: "Multi-agent session attribution", desc: "Per-session identity across parallel agent runs.", target: "2026-08-28", status: "upcoming",
    about: "As more agents run at once, every write needs to say which agent and which session produced it. The bet is that one immutable feed plus per-session identity scales further than a store per agent.",
    gh: "milestone/7",
    issues: [{ n: 242, closed: false, title: "Session token issuance for agents" }, { n: 245, closed: false, title: "Per-session author chips" }, { n: 248, closed: false, title: "Concurrent-write conflict detection" }, { n: 251, closed: false, title: "Session timeline in Feed" }, { n: 254, closed: false, title: "Attribution in diff view" }, { n: 257, closed: false, title: "Agent registry" }, { n: 260, closed: false, title: "Session-scoped rate limits" }] },
  { id: "m8", title: "Self-host & deploy guide", desc: "Run the whole store on your own infrastructure.", target: "2026-09-20", status: "upcoming",
    about: "Keeping a small team in control of its own working memory. A documented path to run Canopy and its MCP server on your own infrastructure, with backups and upgrades that a four-person team can actually operate.",
    gh: "milestone/8",
    issues: [{ n: 263, closed: false, title: "Single-container deploy image" }, { n: 266, closed: false, title: "Postgres backup + restore guide" }, { n: 269, closed: false, title: "Env + secrets reference" }, { n: 272, closed: false, title: "Zero-downtime upgrade path" }, { n: 275, closed: false, title: "Self-host quickstart doc" }] },
];

export interface Token {
  id: string;
  name: string;
  created: string;
  lastUsed: string;
}

export const initTokens: Token[] = [
  { id: "k1", name: "mcp-cli", created: "Mar 2, 2026", lastUsed: "2h ago" },
  { id: "k2", name: "ci-runner", created: "Jan 18, 2026", lastUsed: "5d ago" },
];

export interface DocTreePage {
  id: string;
  title: string;
  badge?: string;
}
export interface DocTreeGroup {
  section: string;
  pages: DocTreePage[];
}

export const docTree: DocTreeGroup[] = [
  { section: "Reference", pages: [{ id: "auth", title: "Auth" }, { id: "mcp", title: "MCP Server" }, { id: "feed", title: "Feed" }, { id: "docs", title: "Docs" }, { id: "triage", title: "Triage" }, { id: "search", title: "Search" }, { id: "datamodel", title: "Data Model" }] },
  { section: "Context", pages: [{ id: "overview", title: "Product Overview" }, { id: "team", title: "Team & Roles" }, { id: "glossary", title: "Glossary" }] },
  { section: "Decisions", pages: [{ id: "adr1", title: "ADR-001 · Postgres for the store", badge: "RATIFIED" }, { id: "adr2", title: "ADR-002 · Single-accent system", badge: "RATIFIED" }, { id: "adr3", title: "ADR-003 · Agent write contract", badge: "DRAFT" }] },
];

export interface DocMeta {
  section: string;
  title: string;
  who: PersonKey;
  at: string;
  kind: "ref" | "decision";
  staged: boolean;
  lede?: string;
  idLabel?: string;
  badge?: string;
  context?: string;
  decision?: string;
  rationale?: string;
}

export const docMeta: Record<string, DocMeta> = {
  mcp: { section: "Reference", title: "MCP Server", who: "mei", at: "2 days ago", kind: "ref", staged: true, lede: "The MCP server is the only write path into Canopy. Coding agents connect over the Model Context Protocol and post session output through a typed contract; nothing else can mutate the store." },
  auth: { section: "Reference", title: "Auth", who: "dev", at: "5 hours ago", kind: "ref", staged: false, lede: "Sign-in is delegated to GitHub OAuth and gated on membership of the sapling-dev organization. Non-members reach a locked dead-end with no app behind it." },
  feed: { section: "Reference", title: "Feed", who: "mei", at: "4 days ago", kind: "ref", staged: false, lede: "The Feed is the append-only log of everything the team has done. Entries are immutable; corrections are new entries that reference the original." },
  docs: { section: "Reference", title: "Docs", who: "sana", at: "6 days ago", kind: "ref", staged: false, lede: "Docs is the reading surface for promoted sections, grouped into Reference, Context, and Decisions. There is no editor — pages are written by agents and promoted through Triage." },
  triage: { section: "Reference", title: "Triage", who: "jose", at: "1 week ago", kind: "ref", staged: false, lede: "Triage is the human review console where staged agent output becomes accepted truth. Promote, ratify, or place — every change passes through a person here." },
  search: { section: "Reference", title: "Search", who: "mei", at: "1 day ago", kind: "ref", staged: false, lede: "Search spans feed entries and docs in one ranked list. The result shape is fixed so semantic ranking can be added later without changing the surface." },
  datamodel: { section: "Reference", title: "Data Model", who: "dev", at: "2 weeks ago", kind: "ref", staged: false, lede: "Three first-class objects: sections, feed entries, and decisions. Every section has exactly one promoted version and zero or more staged proposals awaiting review." },
  overview: { section: "Context", title: "Product Overview", who: "sana", at: "2 weeks ago", kind: "ref", staged: false, lede: "Canopy is the shared source of truth and working memory for Sapling, a four-person software team. It is read by humans and written almost entirely by their coding agents." },
  team: { section: "Context", title: "Team & Roles", who: "jose", at: "3 weeks ago", kind: "ref", staged: false, lede: "Sapling is Jose, Mei, Dev, and Sana. Authorship in Canopy follows the GitHub identity of whoever ran the session that produced a change." },
  glossary: { section: "Context", title: "Glossary", who: "sana", at: "2 days ago", kind: "ref", staged: false, lede: "Shared vocabulary for the store. The promoted/staged and ratified/draft distinctions are the whole architecture in two words each." },
  adr1: { section: "Decisions", title: "Postgres for the store", idLabel: "ADR-001", who: "sana", at: "3 weeks ago", kind: "decision", badge: "RATIFIED", staged: false, context: "Canopy needs durable, queryable storage for sections, an append-only feed, and version history. The team is small and wants minimal operational surface.", decision: "Use a single Postgres instance as the store. Sections, versions, feed entries, and decisions are all rows; full-text search runs on Postgres until volume justifies a dedicated index.", rationale: "Postgres gives transactional non-destructive writes, JSONB for flexible agent payloads, and built-in full-text search — one dependency the whole team already knows, with a clear path to scale out later." },
  adr2: { section: "Decisions", title: "Single-accent color system", idLabel: "ADR-002", who: "dev", at: "2 weeks ago", kind: "decision", badge: "RATIFIED", staged: false, context: "Early mocks used several accent colors and gray surfaces; state badges blurred together and the tool felt generic.", decision: "One electric-green accent with two tuned values (bright on black, deepened on white). No gray surfaces — separate everything with hairline borders. State is carried by a fixed four-color badge set.", rationale: "A single accent keeps the live and active state unambiguous and the interface stark and fast to scan, which suits a reference tool the team checks constantly." },
  adr3: { section: "Decisions", title: "Agent write contract", idLabel: "ADR-003", who: "dev", at: "4 hours ago", kind: "decision", badge: "DRAFT", staged: false, context: "Agents post to Canopy at the end of a session over MCP. Without a fixed contract, writes arrived in inconsistent shapes and some could not be placed.", decision: "Agents write through a typed contract: every write targets a known section key, carries a change summary and confidence flag, and lands as STAGED — never promoted directly. Unplaceable writes go to Triage.", rationale: "Keeping every agent write non-destructive and staged preserves the human review gate the system depends on, while the confidence flag lets reviewers move fast." },
};

export interface DocVersion {
  label: string;
  who: PersonKey;
  at: string;
  note: string;
  current?: boolean;
}

export const docVersions: DocVersion[] = [
  { label: "v4", who: "mei", at: "2 days ago", note: "Constant-time comparison note", current: true },
  { label: "v3", who: "jose", at: "2 weeks ago", note: "Added the rotation section" },
  { label: "v2", who: "mei", at: "1 month ago", note: "Documented the typed contract" },
  { label: "v1", who: "dev", at: "2 months ago", note: "Initial page" },
];

export type SearchType = "doc" | "feed" | "decision";
export interface SearchSource {
  type: SearchType;
  typeLabel: string;
  section: string;
  title: string;
  who: PersonKey;
  tags: string[];
  snippet: string;
  mark: string;
  /** Phase-1 nav target: the screen/doc this result jumps to. */
  go: { kind: "feed" } | { kind: "doc"; id: string };
}

export const searchSources: SearchSource[] = [
  { type: "doc", typeLabel: "Doc", section: "Reference", title: "MCP Server", who: "mei", tags: ["mcp-server", "security"], snippet: "Each request carries a bearer token in the Authorization header. Tokens are compared in constant time, then matched against the store.", mark: "token", go: { kind: "doc", id: "mcp" } },
  { type: "feed", typeLabel: "Feed", section: "Feed", title: "Switched MCP token comparison to constant-time", who: "jose", tags: ["mcp-server", "security"], snippet: "Replaces the early-return string compare flagged in #138. Adds a timing test that fails on the old implementation.", mark: "token", go: { kind: "feed" } },
  { type: "doc", typeLabel: "Doc", section: "Reference", title: "Auth", who: "dev", tags: ["auth"], snippet: "After the OAuth exchange, Canopy checks org membership before issuing a session token to the client.", mark: "token", go: { kind: "doc", id: "auth" } },
  { type: "feed", typeLabel: "Feed", section: "Feed", title: "Added last-used tracking to MCP access tokens", who: "dev", tags: ["mcp-server", "settings"], snippet: "Every token now records a last-used timestamp, surfaced in the Settings token manager.", mark: "token", go: { kind: "feed" } },
  { type: "decision", typeLabel: "Decision", section: "Decisions", title: "ADR-003 · Agent write contract", who: "dev", tags: ["decisions"], snippet: "Every write carries a change summary and a confidence flag, and lands as staged — never directly promoted.", mark: "token", go: { kind: "doc", id: "adr3" } },
  { type: "doc", typeLabel: "Doc", section: "Context", title: "Glossary", who: "sana", tags: ["docs"], snippet: "token — a minted MCP credential that authorizes an agent to write to the store. Shown once at creation.", mark: "token", go: { kind: "doc", id: "glossary" } },
];

/** Pinned "now" so overdue / next-up are deterministic (design used 2026-06-24). */
export const TODAY_ISO = "2026-06-24";
