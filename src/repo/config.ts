// The environments the dashboard reports on. Configuration, not capture: which
// branch deploys where is a fact about the team's setup that no webhook states.
export interface RepoEnvConfig {
  key: string;            // stable id stored on rows: "staging" | "production"
  label: string;          // card title
  note: string | null;    // the branch, shown beside the label
  branch: string;         // the git branch this environment deploys from
  railwayEnv: string;     // GitHub deployment `environment`, e.g. "Sapling / staging"
  worker: string;         // Cloudflare Worker script name
  workerCheck: string;    // the check run Workers Builds posts, e.g. "Workers Builds: frontend-staging"
  frontendUrl: string;
  apiUrl: string;
  healthPath: string;     // appended to apiUrl
  railwayEnvironmentId?: string;
  railwayServiceId?: string;
}

const REQUIRED = ["key", "label", "branch", "railwayEnv", "worker", "workerCheck", "frontendUrl", "apiUrl", "healthPath"] as const;

/** Parse `REPO_ENVIRONMENTS`. Absent or malformed → [] (the dashboard then shows not_connected). */
export function repoEnvironments(env: { REPO_ENVIRONMENTS?: string }): RepoEnvConfig[] {
  if (!env.REPO_ENVIRONMENTS) return [];
  try {
    const parsed = JSON.parse(env.REPO_ENVIRONMENTS) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is RepoEnvConfig =>
      !!e && typeof e === "object" && REQUIRED.every((k) => typeof (e as Record<string, unknown>)[k] === "string"))
      .map((e) => ({ ...e, note: e.note ?? null }));
  } catch { return []; }
}
