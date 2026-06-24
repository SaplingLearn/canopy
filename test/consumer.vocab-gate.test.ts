import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { IngestPayload } from "@shared/contract";
import { consume } from "../src/consumer";
import { get_feed } from "../src/tools/reads";
import { all } from "../src/db";
import type { NeedsTriageRow, DocVersionRow } from "@shared/rows";

const session = { author: "andres", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" };

describe("vocabulary gate", () => {
  it("writes in-vocab feed entries and routes out-of-vocab tags to needs_triage", async () => {
    const payload = IngestPayload.parse({
      session,
      feed_entries: [
        { summary: "known", body: "good", tags: ["auth"], artifacts: { prs: [], commits: [] } },
        { summary: "unknown", body: "bad", tags: ["not-a-real-tag"], artifacts: { prs: [], commits: [] } },
      ],
    });

    const result = await consume(env.DB, payload);
    expect(result.feed).toBe(1);
    expect(result.triaged).toBe(1);

    const feed = await get_feed(env.DB, {});
    expect(feed.some((f) => f.summary === "known")).toBe(true);
    expect(feed.some((f) => f.summary === "unknown")).toBe(false);

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(1);
    expect(triage[0].reason).toContain("not-a-real-tag");
  });

  it("routes out-of-vocab doc sections and low-confidence items to triage, stages valid ones", async () => {
    const payload = IngestPayload.parse({
      session,
      doc_proposals: [
        { slug: "good-doc", section: "reference", body: "ok", change_summary: "s", confidence: "high" },
        { slug: "bad-section", section: "made-up", body: "x", change_summary: "s", confidence: "high" },
        { slug: "low-conf", section: "reference", body: "x", change_summary: "s", confidence: "low" },
      ],
      adr_drafts: [
        { title: "good adr", context: "c", decision: "d", rationale: "r", confidence: "high" },
        { title: "weak adr", context: "c", decision: "d", rationale: "r", confidence: "low" },
      ],
      needs_triage: [{ raw: "raw blob", reason: "ambiguous section" }],
    });

    const result = await consume(env.DB, payload);
    expect(result.docs).toBe(1);
    expect(result.adrs).toBe(1);
    // bad-section + low-conf doc + weak adr + explicit triage item = 4
    expect(result.triaged).toBe(4);

    const staged = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(staged.length).toBe(1);
    expect(staged[0].slug).toBe("good-doc");

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(4);
  });
});
