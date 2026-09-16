export type DB = D1Database;

/** Current time as an ISO8601 string. Allowed in the Workers runtime. */
export const nowIso = (): string => new Date().toISOString();

/** First row of a query, or null. */
export async function first<T>(db: DB, query: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(query).bind(...params).first<T>()) ?? null;
}

/** All rows of a query (empty array if none). */
export async function all<T>(db: DB, query: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await db.prepare(query).bind(...params).all<T>();
  return results ?? [];
}

/** Run a write and return the D1 result (use res.meta.last_row_id for inserts). */
export async function run(db: DB, query: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(query).bind(...params).run();
}

// ── id-list fan-out (the 100-bound-parameter ceiling) ────────────────────────
//
// D1 caps a single statement at 100 BOUND PARAMETERS. Any `… IN (?, ?, …)` built
// from a row-id list therefore has a hard ceiling: past it D1 throws
// `too many SQL variables` and the whole read 500s — permanently, because the
// list only ever grows. Every grouped read that fans out over ids (the ticket
// queue's assignees/links/subs, a sprint's ticket links, query()'s hydration)
// runs its statement ONCE PER CHUNK and merges the rows.
//
// 80, not 100: a fan-out usually binds a few non-id params too (statuses, a
// scope), and the margin means a caller never has to reason about the budget.

/** `IN (?, ?, …)` placeholders for `n` bound params. */
export const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** Max ids bound into one `IN (…)` list — see the note above. */
export const ID_CHUNK = 80;

/** Split an id list into `IN (…)`-sized chunks. An empty list yields no chunks. */
export function chunked<T>(xs: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Run one `IN (…)` fan-out per id chunk and concatenate the rows. `sql(ph)` is
 * handed the placeholder list for the chunk; `leading` params (if any) bind
 * BEFORE the ids, matching their position in the statement. Row order is
 * preserved within a chunk, which is all a keyed-by-id merge needs — every row
 * for a given id lands in exactly one chunk.
 */
export async function fanOut<R>(
  db: DB,
  ids: readonly (string | number)[],
  sql: (placeholders: string) => string,
  leading: unknown[] = []
): Promise<R[]> {
  const out: R[] = [];
  for (const chunk of chunked(ids)) {
    out.push(...(await all<R>(db, sql(ph(chunk.length)), ...leading, ...chunk)));
  }
  return out;
}
