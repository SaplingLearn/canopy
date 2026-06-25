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

// Proposal, Decision, TriageItem, DiffLine, DiffKind, initProposals, initDecisions,
// initTriage deleted in Phase-2 Task 5 — the Triage screen now renders real
// StagedProposal/AdrRow/NeedsTriageRow shapes via web/src/api.ts. The lineDiff
// helper and DiffRow/DiffKind types live in render.ts.

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
