import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { mintToken, resolveToken } from "../src/auth/tokens";
import { first } from "../src/db";
import { seedPerson } from "./helpers/persons";

describe("mcp tokens", () => {
  it("mints a prefixed token, stores only its hash, and resolves it to the owner (bumping last_used_at)", async () => {
    await seedPerson("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    expect(raw.startsWith("canopy_mcp_")).toBe(true);

    expect(await resolveToken(env.DB, raw)).toEqual({ handle: "real-user" });

    const row = await first<{ last_used_at: string | null; token_hash: string }>(
      env.DB, `SELECT last_used_at, token_hash FROM mcp_tokens WHERE person = ?`, "real-user");
    expect(row?.last_used_at).not.toBeNull();
    expect(row?.token_hash).not.toBe(raw); // never the raw token
  });

  it("rejects an unknown token", async () => {
    expect(await resolveToken(env.DB, "canopy_mcp_unknown")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    await seedPerson("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    await env.DB.prepare(`UPDATE mcp_tokens SET revoked = 1 WHERE person = ?`).bind("real-user").run();
    expect(await resolveToken(env.DB, raw)).toBeNull();
  });
});
