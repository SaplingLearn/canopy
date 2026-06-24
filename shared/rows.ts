// One type per D1 table — the exact row shape returned by db helpers.
export interface SectionRow { name: string; description: string | null; }
export interface TagRow { tag: string; description: string | null; }

export interface DocRow {
  slug: string;
  section: string;
  title: string;
  body: string;
  current_version: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface DocVersionRow {
  id: number;
  slug: string;
  version: number;
  body: string;
  summary: string | null;
  status: "staged" | "promoted";
  confidence: string | null;
  created_at: string;
  created_by: string;
}

export interface FeedRow {
  id: number;
  author: string;
  summary: string;
  body: string | null;
  artifacts: string | null;
  created_at: string;
}

export interface AdrRow {
  id: number;
  title: string;
  context: string | null;
  decision: string | null;
  rationale: string | null;
  status: "draft" | "ratified";
  confidence: string | null;
  created_at: string;
  created_by: string;
}

export interface EntryTagRow {
  tag: string;
  entry_type: "doc" | "feed" | "adr";
  entry_id: string;
}

export interface NeedsTriageRow {
  id: number;
  raw: string;
  reason: string;
  source_author: string | null;
  resolved: number;
  created_at: string;
}
