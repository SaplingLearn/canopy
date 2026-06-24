// Controlled vocabulary — the single editable source of truth for the gate.
// These values MUST match migrations/0002_seed_vocab.sql.
export const SECTIONS = ["reference", "context", "decisions", "needs-triage"] as const;
export const TAGS = ["auth", "architecture", "infra", "api", "ui", "data"] as const;

export type Section = (typeof SECTIONS)[number];

export const isSection = (s: string): s is Section =>
  (SECTIONS as readonly string[]).includes(s);

export const isTag = (t: string): boolean =>
  (TAGS as readonly string[]).includes(t);
