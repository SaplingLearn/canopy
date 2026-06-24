import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { all } from "../src/db";
import type { FeedRow } from "@shared/rows";

const ingestBody = JSON.stringify({
  session: { author: "x", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" },
  feed_entries: [{ summary: "s", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [] } }],
});

describe("auth gate (fails closed)", () => {
  it("rejects an unauthenticated write with 401 and writes nothing", async () => {
    const res = await SELF.fetch("https://example.com/ingest", {
      method: "POST", headers: { "content-type": "application/json" }, body: ingestBody,
    });
    expect(res.status).toBe(401);
    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(0); // nothing written
  });

  it("rejects /mcp with a bad bearer using a bare 401 (no WWW-Authenticate, no OAuth advertisement)", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sapling_mcp_bad",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});
