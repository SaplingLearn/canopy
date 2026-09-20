import type { RepoEnvConfig } from "../../src/repo/config";

export const ENVS: RepoEnvConfig[] = [
  { key: "staging", label: "staging", note: "main", branch: "main", railwayEnv: "Sapling / staging", worker: "frontend-staging", workerCheck: "Workers Builds: frontend-staging", frontendUrl: "https://staging.saplinglearn.com", apiUrl: "https://api.staging.saplinglearn.com", healthPath: "/api/health" },
  { key: "production", label: "production", note: "production", branch: "production", railwayEnv: "Sapling / production", worker: "frontend", workerCheck: "Workers Builds: frontend", frontendUrl: "https://saplinglearn.com", apiUrl: "https://api.saplinglearn.com", healthPath: "/api/health" },
];
