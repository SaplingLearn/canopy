import type { DocRow, DocVersionRow, AdrRow } from "@shared/rows";
import { type DB, first, run, nowIso } from "../db";

const humanizeSlug = (slug: string): string =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function append_feed(
  db: DB,
  entry: { author: string; summary: string; body?: string; artifacts?: unknown; tags?: string[] }
): Promise<number> {
  const created_at = nowIso();
  const res = await run(
    db,
    `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, ?, ?, ?, ?)`,
    entry.author,
    entry.summary,
    entry.body ?? null,
    entry.artifacts !== undefined ? JSON.stringify(entry.artifacts) : null,
    created_at
  );
  const id = res.meta.last_row_id as number;
  for (const tag of entry.tags ?? []) {
    await run(
      db,
      `INSERT OR IGNORE INTO entry_tags (tag, entry_type, entry_id) VALUES (?, 'feed', ?)`,
      tag,
      String(id)
    );
  }
  return id;
}

export async function propose_doc_update(
  db: DB,
  proposal: {
    slug: string;
    section: string;
    title?: string;
    body: string;
    change_summary: string;
    confidence: "high" | "low";
  },
  author: string
): Promise<{ slug: string; version: number; status: "staged" }> {
  const created_at = nowIso();
  const existing = await first<DocRow>(db, `SELECT * FROM docs WHERE slug = ?`, proposal.slug);

  if (!existing) {
    // Title resolution on first creation only: proposal.title ?? humanizeSlug(slug).
    // (On an existing doc we never rewrite title/section — a human may have set them.)
    const title = proposal.title ?? humanizeSlug(proposal.slug);
    await run(
      db,
      `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by)
       VALUES (?, ?, ?, '', 0, ?, ?)`,
      proposal.slug,
      proposal.section,
      title,
      created_at,
      author
    );
  }

  const max = await first<{ v: number | null }>(
    db,
    `SELECT MAX(version) AS v FROM doc_versions WHERE slug = ?`,
    proposal.slug
  );
  const version = (max?.v ?? 0) + 1;

  await run(
    db,
    `INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by)
     VALUES (?, ?, ?, ?, 'staged', ?, ?, ?)`,
    proposal.slug,
    version,
    proposal.body,
    proposal.change_summary,
    proposal.confidence,
    created_at,
    author
  );

  // docs.current_version intentionally untouched — promotion is a human action (out of scope).
  return { slug: proposal.slug, version, status: "staged" };
}

export async function stage_adr(
  db: DB,
  draft: { title: string; context: string; decision: string; rationale: string; confidence: "high" | "low" },
  author: string
): Promise<number> {
  const created_at = nowIso();
  const res = await run(
    db,
    `INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    draft.title,
    draft.context,
    draft.decision,
    draft.rationale,
    draft.confidence,
    created_at,
    author
  );
  return res.meta.last_row_id as number;
}

export async function route_triage(
  db: DB,
  item: { raw: unknown; reason: string; source_author?: string }
): Promise<number> {
  const created_at = nowIso();
  const raw = typeof item.raw === "string" ? item.raw : JSON.stringify(item.raw);
  const res = await run(
    db,
    `INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at)
     VALUES (?, ?, ?, 0, ?)`,
    raw,
    item.reason,
    item.source_author ?? null,
    created_at
  );
  return res.meta.last_row_id as number;
}

/**
 * Human confirmation: promote a staged doc version into the live doc.
 * Non-destructive — prior versions remain. Rejects if the version is missing or not staged.
 */
export async function promote_doc(
  db: DB,
  slug: string,
  version: number,
  author: string
): Promise<{ slug: string; version: number; status: "promoted" }> {
  const ver = await first<DocVersionRow>(
    db,
    `SELECT * FROM doc_versions WHERE slug = ? AND version = ?`,
    slug,
    version
  );
  if (!ver) throw new Error(`no such doc version: ${slug} v${version}`);
  if (ver.status !== "staged") throw new Error(`doc version not staged: ${slug} v${version} is ${ver.status}`);

  const updated_at = nowIso();
  await run(db, `UPDATE doc_versions SET status = 'promoted' WHERE slug = ? AND version = ?`, slug, version);
  await run(
    db,
    `UPDATE docs SET body = ?, current_version = ?, updated_at = ?, updated_by = ? WHERE slug = ?`,
    ver.body,
    version,
    updated_at,
    author,
    slug
  );
  return { slug, version, status: "promoted" };
}

/** Human confirmation: ratify an ADR draft. Rejects if missing or already ratified. */
export async function ratify_adr(db: DB, id: number): Promise<{ id: number; status: "ratified" }> {
  const adr = await first<AdrRow>(db, `SELECT * FROM adrs WHERE id = ?`, id);
  if (!adr) throw new Error(`no such adr: ${id}`);
  if (adr.status === "ratified") throw new Error(`adr already ratified: ${id}`);
  await run(db, `UPDATE adrs SET status = 'ratified' WHERE id = ?`, id);
  return { id, status: "ratified" };
}
