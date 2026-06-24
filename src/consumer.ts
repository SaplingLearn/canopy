import type { IngestPayload } from "@shared/contract";
import { isSection, isTag } from "@shared/vocabulary";
import { type DB } from "./db";
import { append_feed, propose_doc_update, stage_adr, route_triage } from "./tools/writes";

export interface IngestResult {
  feed: number;
  docs: number;
  adrs: number;
  triaged: number;
}

/**
 * Validate-and-write the (already structurally-validated) payload.
 * The Worker verifies structure; this gate verifies vocabulary and confidence.
 * Nothing out-of-vocab or low-confidence is guessed — it goes to needs_triage.
 */
export async function consume(db: DB, payload: IngestPayload): Promise<IngestResult> {
  const author = payload.session.author;
  const result: IngestResult = { feed: 0, docs: 0, adrs: 0, triaged: 0 };

  // Feed: append-only, but any out-of-vocab tag routes the WHOLE entry to triage.
  for (const entry of payload.feed_entries) {
    const unknown = entry.tags.filter((t) => !isTag(t));
    if (unknown.length > 0) {
      await route_triage(db, { raw: entry, reason: `unknown tag: ${unknown.join(", ")}`, source_author: author });
      result.triaged++;
      continue;
    }
    await append_feed(db, {
      author,
      summary: entry.summary,
      body: entry.body,
      artifacts: entry.artifacts,
      tags: entry.tags,
    });
    result.feed++;
  }

  // Docs: section must be in-vocab AND confidence high; staged non-destructively.
  for (const proposal of payload.doc_proposals) {
    if (!isSection(proposal.section)) {
      await route_triage(db, { raw: proposal, reason: `out-of-vocab section: ${proposal.section}`, source_author: author });
      result.triaged++;
      continue;
    }
    if (proposal.confidence === "low") {
      await route_triage(db, { raw: proposal, reason: "low confidence doc proposal", source_author: author });
      result.triaged++;
      continue;
    }
    await propose_doc_update(db, proposal, author);
    result.docs++;
  }

  // ADRs: confidence high; staged as 'draft' for human ratification.
  for (const draft of payload.adr_drafts) {
    if (draft.confidence === "low") {
      await route_triage(db, { raw: draft, reason: "low confidence adr draft", source_author: author });
      result.triaged++;
      continue;
    }
    await stage_adr(db, draft, author);
    result.adrs++;
  }

  // Explicit triage items: written directly.
  for (const item of payload.needs_triage) {
    await route_triage(db, { raw: item.raw, reason: item.reason, source_author: author });
    result.triaged++;
  }

  return result;
}
