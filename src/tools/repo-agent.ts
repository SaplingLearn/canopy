// The Repo dashboard, shaped for an AGENT — the read behind MCP `get_repo_dashboard`.
//
// This is a VIEW over the projection, never a second projection: every number
// comes from `getRepoDashboard` (src/tools/repo.ts — D1 only, nothing on that
// path fetches), exactly what `GET /repo/dashboard` hands the screen. All this
// file does is make it fit an agent's context:
//   · `tab`   — only the sections that tab shows (`REPO_TAB_SECTIONS`, the ONE
//               section→tab mapping, shared with web/src/repo.ts);
//   · `range` — the usage / cloudflare / product sections carry three ranges
//               for the screen's selector; an agent gets ONE;
//   · trends  — sparkline arrays are stripped unless asked for.
// A section's STATUS is never touched: `not_connected` and `empty` pass through
// as they are — unknown is never coerced into a zero or an empty list.
//
// READ-ONLY. The on-demand poll (`POST /admin/poll-usage`) and Sync GitHub stay
// session-cookie + admin routes and are never MCP tools.

import {
  REPO_TAB_SECTIONS,
  type RepoDashboard, type RepoDrift, type RepoProduct, type RepoRange, type RepoSection, type RepoSectionName, type RepoTab,
} from "@shared/repo";
import type { DB } from "../db";
import type { RepoEnvConfig } from "../repo/config";
import { emptyRepoDashboard, getRepoDashboard } from "./repo";

export const DEFAULT_AGENT_RANGE: RepoRange = "7d";

export interface RepoAgentOptions {
  /** Omitted → every section. */
  tab?: RepoTab;
  /** Omitted → `7d`. */
  range?: RepoRange;
  /** Omitted → false: no `trend` arrays, and drift groups carry a count, not commits. */
  includeTrends?: boolean;
}

export interface RepoAgentView {
  repo: string;
  generatedAt: string;
  degraded: boolean;
  tab: RepoTab | "all";
  range: RepoRange;
  sections: Partial<Record<RepoSectionName, RepoSection<unknown>>>;
}

const ALL_SECTIONS: readonly RepoSectionName[] = Object.values(REPO_TAB_SECTIONS).flat();

/** The sections whose data is `Record<RepoRange, …>` on the wire. */
const RANGED: ReadonlySet<RepoSectionName> = new Set<RepoSectionName>(["usage", "cloudflare"]);

/** A product count carries one figure per range; an agent gets the asked one. */
function productForRange(product: RepoProduct, range: RepoRange): unknown {
  return product.map((e) => ({
    ...e,
    groups: e.groups.map((g) => ({
      ...g,
      metrics: g.metrics.map(({ values, raw, ...rest }) => ({ ...rest, value: values[range], raw: raw[range] })),
    })),
  }));
}

/** Drift can carry up to 250 commits a side — the one list in the DTO with no
 *  small bound. The header (`ahead` / `behind`) and each group's tag / title /
 *  meta always travel; the per-commit breakdown only with `include_trends`. */
function driftView(drift: RepoDrift, includeTrends: boolean): unknown {
  return {
    ...drift,
    groups: drift.groups.map(({ commits, ...g }) => ({ ...g, commitCount: commits.length, ...(includeTrends ? { commits } : {}) })),
  };
}

/** A deep copy without any key named `trend` — every sparkline series in the
 *  DTO is spelled that way (usage metrics, product counts/totals, CI failures,
 *  coverage, bundle, TODOs), so a new one is stripped without a change here. */
function withoutTrends(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutTrends);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "trend") out[k] = withoutTrends(x);
    return out;
  }
  return v;
}

/** PURE: the projection in, the agent's view out. Never mutates `dash`. */
export function shapeRepoDashboard(dash: RepoDashboard, opts: RepoAgentOptions = {}): RepoAgentView {
  const range = opts.range ?? DEFAULT_AGENT_RANGE;
  const includeTrends = opts.includeTrends ?? false;
  const names = opts.tab ? REPO_TAB_SECTIONS[opts.tab] : ALL_SECTIONS;

  const sections: RepoAgentView["sections"] = {};
  for (const name of names) {
    const section = dash[name] as RepoSection<unknown> | undefined;
    if (!section || section.status !== "ok") {
      // Passed through untouched — and a section this payload lacks is unknown.
      sections[name] = section ? { status: section.status } : { status: "not_connected" };
      continue;
    }
    let data: unknown = section.data;
    if (RANGED.has(name)) data = (data as Record<RepoRange, unknown>)[range];
    else if (name === "product") data = productForRange(data as RepoProduct, range);
    else if (name === "drift") data = driftView(data as RepoDrift, includeTrends);
    sections[name] = { status: "ok", data: includeTrends ? data : withoutTrends(data) };
  }

  return { repo: dash.repo, generatedAt: dash.generatedAt, degraded: dash.degraded, tab: opts.tab ?? "all", range, sections };
}

/** The route's behaviour, mirrored: a projection throw is the degraded empty
 *  dashboard, never an error to the caller. D1 only — nothing here may fetch. */
export async function getRepoDashboardForAgent(
  db: DB,
  repo: string,
  envs: RepoEnvConfig[],
  opts: RepoAgentOptions = {},
  now: number = Date.now()
): Promise<RepoAgentView> {
  let dash: RepoDashboard;
  try {
    dash = await getRepoDashboard(db, repo, now, envs);
  } catch {
    dash = emptyRepoDashboard(repo, true);
  }
  return shapeRepoDashboard(dash, opts);
}
