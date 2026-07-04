/**
 * Mapping-layer tests — backend read shapes → the props the presentational
 * triage components expect (web/src/triage-map.ts). Pure functions, no DOM.
 */
import { describe, it, expect } from "vitest";
import {
  proposalReviewItem, adrReviewItem, reviewItemsFromReads, decodeReviewId, diffEntries,
} from "../web/src/triage-map";
import type { StagedProposal, AdrRow } from "../web/src/api";

function makeProposal(overrides: Partial<StagedProposal> = {}): StagedProposal {
  return {
    slug: "deploy-runbook", version: 7, title: "Deployment Runbook",
    section: "reference", space: "sapling", summary: "Rollback rewritten.",
    author: "octo-agent", confidence: "high", status: "staged",
    change_kind: "edit", low_confidence: 0, base_version: 6, current_version: 6,
    created_at: "2026-07-01T10:00:00Z",
    stagedBody: "line one\nline two", promotedBody: "line one\nold line two",
    ...overrides,
  };
}

function makeAdr(overrides: Partial<AdrRow> = {}): AdrRow {
  return {
    id: 14, title: "Adopt outbox pattern",
    context: "Events diverge silently.",
    decision: "Write events to an outbox table. A relay publishes them.",
    rationale: "One hop of latency is acceptable.",
    status: "draft", confidence: "high",
    created_at: "2026-07-02T10:00:00Z", created_by: "octo-agent", content_hash: null,
    ...overrides,
  };
}

describe("proposalReviewItem", () => {
  it("synthesizes the doc id and decodeReviewId round-trips it", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.id).toBe("doc:deploy-runbook@7");
    expect(decodeReviewId(item.id)).toEqual({ kind: "doc", slug: "deploy-runbook", version: 7 });
  });

  it("derives the eyebrow from real space/section and fixes kind/badge", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.kind).toBe("proposal");
    expect(item.eyebrow).toBe("PROPOSAL · SAPLING / REFERENCE");
    expect(item.badge).toBe("STAGED");
    expect(item.liveVersion).toBe("LIVE (v6)");
  });

  it("derives agent fields from the author (no session id) and time from created_at", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.agent).toBe("octo-agent");
    expect(item.agentInitials).toBe("OC");
    expect(item.agent).not.toContain("session");
  });

  it("marks stale only when base_version < current_version, with a note naming both", () => {
    const stale = proposalReviewItem(makeProposal({ base_version: 5, current_version: 6 }));
    expect(stale.stale).toBe(true);
    expect(stale.staleNote).toContain("v5");
    expect(stale.staleNote).toContain("v6");
    expect(proposalReviewItem(makeProposal({ base_version: 6, current_version: 6 })).stale).toBe(false);
    expect(proposalReviewItem(makeProposal({ base_version: null })).stale).toBe(false);
  });

  it("falls back to a staged-body excerpt when summary is null", () => {
    const item = proposalReviewItem(makeProposal({ summary: null, stagedBody: "\n\nFirst real line.\nmore" }));
    expect(item.summary).toBe("First real line.");
  });

  it("flags low_confidence proposals", () => {
    expect(proposalReviewItem(makeProposal({ low_confidence: 1 })).flagged).toBe(true);
    expect(proposalReviewItem(makeProposal()).flagged).toBe(false);
  });

  it("computes the diff from the two raw bodies", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.diff!.some((e) => e.t === "del" && e.s === "old line two")).toBe(true);
    expect(item.diff!.some((e) => e.t === "add" && e.s === "line two")).toBe(true);
  });
});

describe("diffEntries — real-size bodies", () => {
  it("collapses a multi-hundred-line body to hunks + ellipsis rows", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const oldBody = lines.join("\n");
    const newLines = [...lines];
    newLines[50] = "changed A";
    newLines[200] = "changed B";
    const rows = diffEntries(oldBody, newLines.join("\n"));
    expect(rows.length).toBeLessThan(50);
    const ellipses = rows.filter((r) => r.t === "ellipsis");
    expect(ellipses.length).toBeGreaterThanOrEqual(2);
    expect(ellipses[0].s).toMatch(/\d+ unchanged lines/);
  });
});

describe("adrReviewItem", () => {
  it("synthesizes the adr id and decodeReviewId round-trips it", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.id).toBe("adr:14");
    expect(decodeReviewId(item.id)).toEqual({ kind: "adr", id: 14 });
  });

  it("formats the eyebrow from the numeric id and fixes kind/badge", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.kind).toBe("decision");
    expect(item.eyebrow).toBe("DECISION · ADR-014");
    expect(item.badge).toBe("DRAFT");
  });

  it("builds Context / Decision / Rationale sections, skipping nulls", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.adr!.map((s) => s.h)).toEqual(["Context", "Decision", "Rationale"]);
    const noRationale = adrReviewItem(makeAdr({ rationale: null }));
    expect(noRationale.adr!.map((s) => s.h)).toEqual(["Context", "Decision"]);
  });

  it("derives the card summary from the first sentence of decision", () => {
    expect(adrReviewItem(makeAdr()).summary).toBe("Write events to an outbox table.");
    expect(adrReviewItem(makeAdr({ decision: null })).summary).toBe("");
  });
});

describe("reviewItemsFromReads", () => {
  it("merges the two reads newest-first by created_at", () => {
    const items = reviewItemsFromReads(
      [makeProposal({ created_at: "2026-07-01T10:00:00Z" })],
      [makeAdr({ created_at: "2026-07-02T10:00:00Z" })],
    );
    expect(items.map((i) => i.id)).toEqual(["adr:14", "doc:deploy-runbook@7"]);
  });
});

describe("decodeReviewId — invalid inputs", () => {
  it("returns null for unknown prefixes and malformed ids", () => {
    expect(decodeReviewId("p1")).toBeNull();
    expect(decodeReviewId("doc:no-version")).toBeNull();
    expect(decodeReviewId("doc:slug@abc")).toBeNull();
    expect(decodeReviewId("adr:abc")).toBeNull();
  });
});
