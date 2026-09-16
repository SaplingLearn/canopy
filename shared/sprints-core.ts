// The ZOD-FREE core of the sprints contract: the controlled vocabulary tuples.
// `shared/sprints.ts` builds its Zod enums on top of these and RE-EXPORTS every
// one of them, so nothing outside this file has to know the split —
// `import { SPRINT_DOMAINS } from "@shared/sprints"` keeps working.
//
// Why the split (the same reason `shared/tickets-core.ts` exists): the SPA needs
// the vocabulary as VALUES at runtime (the New sprint panel's urgency segment and
// domain chips iterate it), and `web/` importing a module that evaluates
// `z.object(...)` at load time drags the whole of zod into the browser bundle
// (+70 kB minified, measured in Phase 5a). This module has no imports at all.
//
// These tuples MUST match the CHECK constraints in `migrations/0025_sprints.sql`.

export const SPRINT_URGENCIES = ["low", "normal", "high"] as const;
export const SPRINT_DOMAINS = ["notifications", "tickets", "gate", "feed", "search", "infra"] as const;
export const SPRINT_STATUSES = ["upcoming", "in_progress", "done"] as const;
export const SPRINT_RESOURCE_KINDS = ["github", "figma", "plain"] as const;

export type SprintUrgency = (typeof SPRINT_URGENCIES)[number];
export type SprintDomain = (typeof SPRINT_DOMAINS)[number];
export type SprintStatus = (typeof SPRINT_STATUSES)[number];
export type SprintResourceKind = (typeof SPRINT_RESOURCE_KINDS)[number];
