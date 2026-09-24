import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";

describe("0029_oauth schema", () => {
  it("creates the four oauth tables", async () => {
    const rows = await all<{ name: string }>(env.DB,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%' ORDER BY name`);
    expect(rows.map((r) => r.name)).toEqual(["oauth_clients", "oauth_codes", "oauth_grants", "oauth_tokens"]);
  });
});
