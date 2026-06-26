import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { feedEntryFromMcpArgs } from "../src/mcp-args";
import { ingestFeedEntry } from "../src/consumer";
import { all } from "../src/db";
import type { FeedRow } from "@shared/rows";

// STEP 0: the MCP `append_feed` tool used to hardcode prs:[]/commits:[] (src/mcp.ts),
// so an agent could only record `issues` on a feed entry. feedEntryFromMcpArgs is the
// exact mapping the tool now delegates to (the thin adapter over the gate); driving it
// proves append_feed stops dropping prs/commits and they round-trip through the gate
// into the stored feed artifacts json. Note: per the contract (shared/contract.ts),
// prs/commits are string[] and issues are number[].
const AUTHOR = "real-user";

describe("append_feed records prs and commits", () => {
  it("maps prs/commits/issues from tool args into the FeedEntry artifacts", () => {
    const entry = feedEntryFromMcpArgs({
      summary: "shipped",
      body: "b",
      tags: ["infra"],
      prs: ["14"],
      commits: ["abc123"],
      issues: [7],
    });
    expect(entry.artifacts).toEqual({ prs: ["14"], commits: ["abc123"], issues: [7] });
  });

  it('round-trips prs:["14"] and commits:["abc123"] into the stored feed artifacts json', async () => {
    const entry = feedEntryFromMcpArgs({
      summary: "shipped",
      body: "widened append_feed",
      tags: ["infra"],
      prs: ["14"],
      commits: ["abc123"],
    });
    const r = await ingestFeedEntry(env.DB, entry, AUTHOR);
    expect(r.outcome).toBe("written");

    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(1);
    const artifacts = JSON.parse(feed[0].artifacts!);
    expect(artifacts.prs).toEqual(["14"]);
    expect(artifacts.commits).toEqual(["abc123"]);
    expect(artifacts.issues).toEqual([]);
  });
});
