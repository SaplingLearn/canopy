import type { RepoEnvConfig } from "../../src/repo/config";

export const ENVS: RepoEnvConfig[] = [
  { key: "staging", label: "staging", note: "main", branch: "main", railwayEnv: "Sapling / staging", worker: "frontend-staging", workerCheck: "Workers Builds: frontend-staging", frontendUrl: "https://staging.saplinglearn.com", apiUrl: "https://api.staging.saplinglearn.com", healthPath: "/api/health" },
  { key: "production", label: "production", note: "production", branch: "production", railwayEnv: "Sapling / production", worker: "frontend", workerCheck: "Workers Builds: frontend", frontendUrl: "https://saplinglearn.com", apiUrl: "https://api.saplinglearn.com", healthPath: "/api/health" },
];

interface GraphqlCall { query: string; variables: Record<string, unknown> }

/** A fake api.github.com keyed by path prefix. Two GraphQL queries POST to the
 *  same `https://api.github.com/graphql` URL (deployments, and branches), so a
 *  graphql call is routed by its QUERY TEXT rather than the URL: the key
 *  `"graphql"` supplies the deployments response (as before), `"refsGraphql"`
 *  the branches response — each defaults to an empty-but-valid shape so a test
 *  that cares about neither doesn't have to mock either. Every call's body is
 *  parsed and recorded (a test can then assert what the query was filtered
 *  by). A `/compare/...` REST call similarly defaults to a zero-diff shape
 *  rather than the generic `"[]"`, so a test that doesn't care about drift
 *  doesn't have to mock it either.
 *
 *  Shared by `test/repo-reconcile.test.ts` and `test/repo-cron.test.ts` — never
 *  import one `.test.ts` from another, so this lives here. */
export function fakeGithub(routes: Record<string, unknown>): { fetchImpl: typeof fetch; calls: string[]; graphql: GraphqlCall[] } {
  const calls: string[] = [];
  const graphql: GraphqlCall[] = [];
  const EMPTY_REFS = { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
  const EMPTY_DEPLOYMENTS = { data: { repository: { deployments: { nodes: [] } } } };
  const EMPTY_COMPARE = { ahead_by: 0, behind_by: 0, commits: [] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith("/graphql")) {
      const call = JSON.parse(String(init?.body ?? "{}")) as GraphqlCall;
      graphql.push(call);
      const isRefs = typeof call.query === "string" && call.query.includes("refs(refPrefix");
      const key = isRefs ? "refsGraphql" : "graphql";
      const body = key in routes ? routes[key] : isRefs ? EMPTY_REFS : EMPTY_DEPLOYMENTS;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const hit = Object.keys(routes).find((k) => k !== "graphql" && k !== "refsGraphql" && url.includes(k));
    if (hit) return new Response(JSON.stringify(routes[hit]), { status: 200 });
    return new Response(JSON.stringify(url.includes("/compare/") ? EMPTY_COMPARE : []), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, graphql };
}
