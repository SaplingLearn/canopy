import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { IngestPayload } from "@shared/contract";
import { consume, ingestDocProposal, ingestFeedEntry } from "../src/consumer";
import { promote_doc } from "../src/tools/writes";
import { all, first } from "../src/db";
import type { DocRow, DocVersionRow, FeedRow, AdrRow, MilestoneProposalRow } from "@shared/rows";

const AUTHOR = "real-user";
const meta = (id: string) => ({ id, author: "advisory", ended_at: "2026-06-24T00:00:00Z", skill_version: "2.0" });

// A full one-of-each payload, parametrized by session id so we can replay it.
function fullPayload(id: string) {
  return IngestPayload.parse({
    session: meta(id),
    feed_entries: [{ summary: "shipped X", body: "did the thing", tags: ["infra"], artifacts: { prs: ["9"], commits: ["abc"], issues: [1] } }],
    doc_proposals: [{ slug: "arch-note", section: "reference", title: "Arch Note", body: "line one\nline two", change_summary: "init", confidence: "high" }],
    adr_drafts: [{ title: "Use D1", context: "need storage", decision: "D1", rationale: "simple", confidence: "high" }],
    milestone_proposals: [{ title: "GA", target_date: "2026-09-01", status: "upcoming", change_summary: "ga", confidence: "high" }],
    focus: { working_on: "reconciler", next_up: "tests" },
  });
}

describe("reconciler — replay safety", () => {
  it("an identical re-POST (same session.id) stages NOTHING new — all-unchanged", async () => {
    const payload = fullPayload("S-replay");

    const firstRun = await consume(env.DB, payload, { login: AUTHOR });
    expect(firstRun.feed.written).toBe(1);
    expect(firstRun.docs.staged).toBe(1);
    expect(firstRun.adrs.staged).toBe(1);
    expect(firstRun.milestones.staged).toBe(1);
    expect(firstRun.focus.unchanged).toBe(1);

    const counts = async () => ({
      feed: (await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length,
      versions: (await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`)).length,
      adrs: (await all<AdrRow>(env.DB, `SELECT * FROM adrs`)).length,
      miles: (await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`)).length,
    });
    const before = await counts();

    // Re-run the SAME payload: the ledger drops every item.
    const secondRun = await consume(env.DB, payload, { login: AUTHOR });
    expect(secondRun.feed).toEqual({ written: 0, unchanged: 1, triaged: 0 });
    expect(secondRun.docs).toEqual({ staged: 0, unchanged: 1, triaged: 0 });
    expect(secondRun.adrs).toEqual({ staged: 0, unchanged: 1, triaged: 0 });
    expect(secondRun.milestones).toEqual({ staged: 0, unchanged: 1, triaged: 0 });

    expect(await counts()).toEqual(before); // zero new rows of any kind
  });

  it("the same feed content under a DIFFERENT session.id is a legal distinct repeat", async () => {
    const a = IngestPayload.parse({ session: meta("S-a"), feed_entries: [{ summary: "dup", body: "b", tags: ["infra"], artifacts: { prs: [], commits: [], issues: [] } }] });
    const b = IngestPayload.parse({ session: meta("S-b"), feed_entries: [{ summary: "dup", body: "b", tags: ["infra"], artifacts: { prs: [], commits: [], issues: [] } }] });

    await consume(env.DB, a, { login: AUTHOR });
    await consume(env.DB, b, { login: AUTHOR });
    expect((await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length).toBe(2); // distinct repeats allowed

    await consume(env.DB, a, { login: AUTHOR }); // replay of A drops
    expect((await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length).toBe(2);
  });
});

describe("reconciler — doc dedupe + change_kind", () => {
  it("drops an unchanged body (same body, new session) and stages no new version", async () => {
    const p1 = IngestPayload.parse({ session: meta("D-1"), doc_proposals: [{ slug: "d", section: "reference", body: "same body", change_summary: "s", confidence: "high" }] });
    const r1 = await consume(env.DB, p1, { login: AUTHOR });
    expect(r1.docs.staged).toBe(1);

    const p2 = IngestPayload.parse({ session: meta("D-2"), doc_proposals: [{ slug: "d", section: "reference", body: "same body", change_summary: "s", confidence: "high" }] });
    const r2 = await consume(env.DB, p2, { login: AUTHOR });
    expect(r2.docs).toEqual({ staged: 0, unchanged: 1, triaged: 0 });
    expect((await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'd'`)).length).toBe(1);
  });

  it("classifies a small change as 'edit' and a large change as 'rewrite', recording base_version", async () => {
    const body1 = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    await ingestDocProposal(env.DB, { slug: "doc", section: "reference", body: body1, change_summary: "v1", confidence: "high" }, AUTHOR);
    await promote_doc(env.DB, "doc", 1, AUTHOR); // current_version → 1, docs.body = body1

    // one line changed out of ten → edit
    const edited = body1.replace("line 5", "line FIVE");
    const e = await ingestDocProposal(env.DB, { slug: "doc", section: "reference", body: edited, change_summary: "tweak", confidence: "high" }, AUTHOR);
    expect(e).toMatchObject({ outcome: "written", change_kind: "edit", base_version: 1 });

    // every line changed → rewrite (proposed against current promoted body, still v1)
    const rewritten = Array.from({ length: 10 }, (_, i) => `totally new ${i}`).join("\n");
    const w = await ingestDocProposal(env.DB, { slug: "doc", section: "reference", body: rewritten, change_summary: "redo", confidence: "high" }, AUTHOR);
    expect(w).toMatchObject({ outcome: "written", change_kind: "rewrite", base_version: 1 });

    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'doc' ORDER BY version`);
    expect(versions.map((v) => v.change_kind)).toEqual(["new", "edit", "rewrite"]);
    expect(versions[1].base_version).toBe(1);
  });

  it("a brand-new slug is change_kind 'new' with a content_hash and no base_version", async () => {
    const r = await ingestDocProposal(env.DB, { slug: "fresh", section: "reference", body: "hello", change_summary: "s", confidence: "high" }, AUTHOR);
    expect(r).toMatchObject({ outcome: "written", change_kind: "new", base_version: null });
    const v = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'fresh'`);
    expect(v?.content_hash).toBeTruthy();
  });

  it("`force` stages a new version even when the body is byte-identical", async () => {
    await ingestDocProposal(env.DB, { slug: "f", section: "reference", body: "x", change_summary: "s", confidence: "high" }, AUTHOR);
    const forced = await ingestDocProposal(env.DB, { slug: "f", section: "reference", body: "x", change_summary: "s", confidence: "high", force: true }, AUTHOR);
    expect(forced.outcome).toBe("written");
    expect((await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'f'`)).length).toBe(2);
  });
});

describe("reconciler — confidence + space", () => {
  it("low-confidence on a NEW slug triages; on an EXISTING slug stages-and-flags", async () => {
    // new + low → triage, no doc created
    const t = await ingestDocProposal(env.DB, { slug: "ghost", section: "reference", body: "x", change_summary: "s", confidence: "low" }, AUTHOR);
    expect(t.outcome).toBe("triaged");
    expect((await all<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = 'ghost'`)).length).toBe(0);

    // existing + low → stage with low_confidence = 1
    await ingestDocProposal(env.DB, { slug: "exists", section: "reference", body: "v1", change_summary: "s", confidence: "high" }, AUTHOR);
    const flagged = await ingestDocProposal(env.DB, { slug: "exists", section: "reference", body: "v2 differs", change_summary: "s", confidence: "low" }, AUTHOR);
    expect(flagged).toMatchObject({ outcome: "written", low_confidence: true });
    const v2 = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'exists' AND version = 2`);
    expect(v2?.low_confidence).toBe(1);
  });

  it("persists `space` on doc creation (default canopy, explicit sapling)", async () => {
    await ingestDocProposal(env.DB, { slug: "default-space", section: "reference", body: "x", change_summary: "s", confidence: "high" }, AUTHOR);
    await ingestDocProposal(env.DB, { slug: "sap", section: "reference", body: "x", change_summary: "s", confidence: "high", space: "sapling" }, AUTHOR);
    expect((await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = 'default-space'`))?.space).toBe("canopy");
    expect((await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = 'sap'`))?.space).toBe("sapling");
  });
});

describe("reconciler — ADR + milestone dedupe", () => {
  it("drops an identical ADR (content hash) but stages a different one", async () => {
    const a = IngestPayload.parse({ session: meta("A-1"), adr_drafts: [{ title: "T", context: "c", decision: "d", rationale: "r", confidence: "high" }] });
    const b = IngestPayload.parse({ session: meta("A-2"), adr_drafts: [{ title: "T", context: "c", decision: "d", rationale: "r", confidence: "high" }] });
    const c = IngestPayload.parse({ session: meta("A-3"), adr_drafts: [{ title: "T", context: "c", decision: "d2", rationale: "r", confidence: "high" }] });

    expect((await consume(env.DB, a, { login: AUTHOR })).adrs.staged).toBe(1);
    expect((await consume(env.DB, b, { login: AUTHOR })).adrs).toEqual({ staged: 0, unchanged: 1, triaged: 0 });
    expect((await consume(env.DB, c, { login: AUTHOR })).adrs.staged).toBe(1);
    expect((await all<AdrRow>(env.DB, `SELECT * FROM adrs`)).length).toBe(2);
  });

  it("drops a milestone with an already-staged title but stages a new one", async () => {
    const a = IngestPayload.parse({ session: meta("M-1"), milestone_proposals: [{ title: "GA", target_date: "2026-09-01", status: "upcoming", change_summary: "s", confidence: "high" }] });
    const b = IngestPayload.parse({ session: meta("M-2"), milestone_proposals: [{ title: "GA", target_date: "2026-10-01", status: "in_progress", change_summary: "s", confidence: "high" }] });
    const c = IngestPayload.parse({ session: meta("M-3"), milestone_proposals: [{ title: "Beta", target_date: "2026-08-01", status: "upcoming", change_summary: "s", confidence: "high" }] });

    expect((await consume(env.DB, a, { login: AUTHOR })).milestones.staged).toBe(1);
    expect((await consume(env.DB, b, { login: AUTHOR })).milestones).toEqual({ staged: 0, unchanged: 1, triaged: 0 });
    expect((await consume(env.DB, c, { login: AUTHOR })).milestones.staged).toBe(1);
    expect((await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`)).length).toBe(2);
  });
});

describe("reconciler — staging stays non-destructive", () => {
  it("never mutates docs.body / current_version while staging deltas", async () => {
    await ingestDocProposal(env.DB, { slug: "nd", section: "reference", body: "v1", change_summary: "s", confidence: "high" }, AUTHOR);
    await promote_doc(env.DB, "nd", 1, AUTHOR);
    const promoted = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = 'nd'`);

    await ingestDocProposal(env.DB, { slug: "nd", section: "reference", body: "v2 staged", change_summary: "s", confidence: "high" }, AUTHOR);
    const after = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = 'nd'`);
    expect(after?.body).toBe(promoted?.body); // live body untouched by the staged v2
    expect(after?.current_version).toBe(1);
  });
});

// Drive the gate's ledger directly (the unit-level replay guard the feed relies on).
describe("reconciler — feed ledger guard at the gate", () => {
  it("a second call at the same (session, index) is dropped as unchanged", async () => {
    const entry = { summary: "s", body: "b", tags: ["infra"], artifacts: { prs: [], commits: [], issues: [] } };
    const ledger = { sessionId: "L1", itemIndex: 0 };
    const r1 = await ingestFeedEntry(env.DB, entry, AUTHOR, ledger);
    expect(r1.outcome).toBe("written");
    const r2 = await ingestFeedEntry(env.DB, entry, AUTHOR, ledger);
    expect(r2.outcome).toBe("unchanged");
    expect((await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length).toBe(1);
  });
});
