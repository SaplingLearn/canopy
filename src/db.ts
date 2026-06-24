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
