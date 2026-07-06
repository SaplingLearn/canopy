// Type surface for build.mjs so TypeScript test files importing it type-check
// under tsconfig.worker.json (which includes test/) without allowJs. The loader
// consumes parsed fixture JSON; the runtime module reads keys defensively, so a
// permissive record is the honest public shape.
export function buildSeedStatements(fx: Record<string, unknown>): string[];
export function targetsRemote(argv: string[]): boolean;
