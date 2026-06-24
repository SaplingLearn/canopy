import type { DocRow, DocVersionRow, FeedRow, AdrRow } from "@shared/rows";
import { type DB, first, all } from "../db";

export async function get_doc(
  db: DB,
  slug: string
): Promise<{ doc: DocRow; versions: DocVersionRow[] } | null> {
  const doc = await first<DocRow>(db, `SELECT * FROM docs WHERE slug = ?`, slug);
  if (!doc) return null;
  const versions = await all<DocVersionRow>(
    db,
    `SELECT * FROM doc_versions WHERE slug = ? ORDER BY version ASC`,
    slug
  );
  return { doc, versions };
}

export async function list_docs(db: DB, section?: string): Promise<DocRow[]> {
  if (section) {
    return all<DocRow>(db, `SELECT * FROM docs WHERE section = ? ORDER BY slug ASC`, section);
  }
  return all<DocRow>(db, `SELECT * FROM docs ORDER BY slug ASC`);
}

export interface FeedFilter {
  author?: string;
  tags?: string[];
  since?: string;
  limit?: number;
}

export async function get_feed(db: DB, filter: FeedFilter = {}): Promise<FeedRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let join = "";

  if (filter.author) {
    clauses.push(`f.author = ?`);
    params.push(filter.author);
  }
  if (filter.since) {
    clauses.push(`f.created_at >= ?`);
    params.push(filter.since);
  }
  if (filter.tags && filter.tags.length > 0) {
    const placeholders = filter.tags.map(() => "?").join(", ");
    join = `JOIN entry_tags et ON et.entry_type = 'feed'
            AND et.entry_id = CAST(f.id AS TEXT) AND et.tag IN (${placeholders})`;
    params.push(...filter.tags);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Clamp to a safe integer; interpolated (not bound) because SQLite rejects bound LIMIT in some drivers.
  const limit = Math.trunc(Math.min(Math.max(filter.limit ?? 50, 1), 500));

  return all<FeedRow>(
    db,
    `SELECT DISTINCT f.* FROM feed f ${join} ${where} ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit}`,
    ...params
  );
}

export interface SearchResult {
  type: "doc" | "feed" | "adr";
  id: string;
  title: string;
  snippet: string;
}

export interface SearchFilters {
  section?: string;
  limit?: number;
}

// Simple D1 text match for v1. SEAM: Vectorize / semantic search is deferred and
// would slot in here without changing the signature.
export async function search_context(
  db: DB,
  query: string,
  filters: SearchFilters = {}
): Promise<SearchResult[]> {
  const like = `%${query}%`;
  const limit = Math.trunc(Math.min(Math.max(filters.limit ?? 25, 1), 200));
  const results: SearchResult[] = [];

  const docParams: unknown[] = [like, like];
  let docSection = "";
  if (filters.section) {
    docSection = ` AND section = ?`;
    docParams.push(filters.section);
  }
  const docs = await all<DocRow>(
    db,
    `SELECT * FROM docs WHERE (title LIKE ? OR body LIKE ?)${docSection} LIMIT ${limit}`,
    ...docParams
  );
  for (const d of docs) {
    results.push({ type: "doc", id: d.slug, title: d.title, snippet: d.body.slice(0, 200) });
  }

  // feed and adrs have no section; only included when no section filter is set.
  if (!filters.section) {
    const feed = await all<FeedRow>(
      db,
      `SELECT * FROM feed WHERE summary LIKE ? OR body LIKE ? LIMIT ${limit}`,
      like,
      like
    );
    for (const f of feed) {
      results.push({ type: "feed", id: String(f.id), title: f.summary, snippet: (f.body ?? "").slice(0, 200) });
    }

    const adrs = await all<AdrRow>(
      db,
      `SELECT * FROM adrs WHERE title LIKE ? OR context LIKE ? OR decision LIKE ? LIMIT ${limit}`,
      like,
      like,
      like
    );
    for (const a of adrs) {
      results.push({ type: "adr", id: String(a.id), title: a.title, snippet: (a.decision ?? "").slice(0, 200) });
    }
  }

  return results;
}
