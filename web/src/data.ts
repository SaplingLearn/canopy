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

// Feed mock + FeedEntry/Artifact types deleted in Phase-2 Task 1 — the Feed screen
// now renders the real FeedRow shape from @shared/rows via web/src/api.ts.

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

// Roadmap mocks (roadmapDoc, milestones, RoadmapPhase, RoadmapDoc, MilestoneStatus,
// MilestoneIssue, Milestone) deleted in Phase-2 Task 4 — the Roadmap screen now renders
// real MilestoneWithProgress shapes from @shared/rows via web/src/api.ts.

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

// Doc mocks (docTree, docMeta, docVersions, DocMeta, DocVersion, DocTreePage, DocTreeGroup)
// deleted in Phase-2 Task 2 — the Docs screen now renders real DocRow/DocVersionRow
// shapes from @shared/rows via web/src/api.ts.

// SearchType, SearchSource, and searchSources deleted in Phase-2 Task 3 — the Search
// screen now renders real SearchResult shapes from ./api via loadSearch() in main.ts.

// TODAY_ISO deleted in Phase-2 Task 4 — roadmapEnriched now uses real Date.now().
