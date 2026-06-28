import { describe, it, expect } from "vitest";
import { feedEntryFromMcpArgs } from "../src/mcp-args";

// Unit test of the feedEntryFromMcpArgs mapping in isolation. The END-TO-END
// proof that the REGISTERED append_feed tool carries prs/commits through the
// gate now lives in test/mcp.append_feed.test.ts (driving the real tool) — the
// prior "round-trip" test here drove the helper + gate directly, never the
// registered tool the live server runs, which is exactly the bug that shipped.
describe("feedEntryFromMcpArgs", () => {
  it("maps prs/commits/issues from tool args into the FeedEntry artifacts", () => {
    const entry = feedEntryFromMcpArgs({
      summary: "shipped",
      body: "b",
      tags: ["infra"],
      prs: ["14"],
      commits: ["abc123"],
      issues: [7],
    });
    expect(entry).toEqual({
      summary: "shipped",
      body: "b",
      tags: ["infra"],
      artifacts: { prs: ["14"], commits: ["abc123"], issues: [7] },
    });
  });

  it("defaults omitted lists to []", () => {
    const entry = feedEntryFromMcpArgs({ summary: "s" });
    expect(entry.artifacts).toEqual({ prs: [], commits: [], issues: [] });
    expect(entry.body).toBe("");
    expect(entry.tags).toEqual([]);
  });
});
