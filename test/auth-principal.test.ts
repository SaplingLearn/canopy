import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { resolveBearerPrincipal } from "../src/auth/principal";
import { mintToken } from "../src/auth/tokens";

async function seedUser(login: string) {
  await env.DB.prepare(`INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`)
    .bind(login, login, "2026-01-01T00:00:00Z").run();
}
const req = (auth?: string) =>
  new Request("https://x/mcp", { method: "POST", headers: auth ? { authorization: auth } : {} });

describe("resolveBearerPrincipal", () => {
  it("resolves a valid bearer to the owner principal", async () => {
    await seedUser("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    expect(await resolveBearerPrincipal(req(`Bearer ${raw}`), env)).toEqual({ login: "real-user" });
  });

  it("returns null when the Authorization header is missing", async () => {
    expect(await resolveBearerPrincipal(req(), env)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveBearerPrincipal(req("Bearer sapling_mcp_unknown"), env)).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    await seedUser("real-user");
    const { raw } = await mintToken(env.DB, "real-user");
    await env.DB.prepare(`UPDATE mcp_tokens SET revoked = 1`).run();
    expect(await resolveBearerPrincipal(req(`Bearer ${raw}`), env)).toBeNull();
  });
});
