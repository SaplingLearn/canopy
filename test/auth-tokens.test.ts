import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { mintToken, resolveToken, listTokens, revokeToken } from "../src/auth/tokens";
import { app } from "../src/routes";
import { first } from "../src/db";
import { seedPerson, cookieFor } from "./helpers/persons";

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

  it("lists a person's live tokens by hint — never the hash, never the raw value — newest first", async () => {
    await seedPerson("real-user"); await seedPerson("other-user");
    const a = await mintToken(env.DB, "real-user");
    await mintToken(env.DB, "other-user");
    await env.DB.prepare(`UPDATE mcp_tokens SET created_at = '2026-01-01T00:00:00.000Z' WHERE person = 'real-user'`).run();
    const b = await mintToken(env.DB, "real-user");

    const list = await listTokens(env.DB, "real-user");
    expect(list.map((t) => t.hint)).toEqual([b.raw.slice(11, 15), a.raw.slice(11, 15)]);
    expect(Object.keys(list[0]).sort()).toEqual(["created_at", "hint", "id", "last_used_at"]);
    expect(list[0].last_used_at).toBeNull();
  });

  it("a token minted before the hint column lists with a null hint", async () => {
    await seedPerson("real-user");
    await env.DB.prepare(`INSERT INTO mcp_tokens (person, token_hash, created_at) VALUES ('real-user', 'legacy-hash', '2026-01-01T00:00:00.000Z')`).run();
    expect((await listTokens(env.DB, "real-user"))[0].hint).toBeNull();
  });

  it("revokes only the caller's own token: it stops resolving and leaves the list; someone else's id is a miss that writes nothing", async () => {
    await seedPerson("real-user"); await seedPerson("other-user");
    const mine = await mintToken(env.DB, "real-user");
    const theirs = await mintToken(env.DB, "other-user");
    const [theirRow] = await listTokens(env.DB, "other-user");
    const [myRow] = await listTokens(env.DB, "real-user");

    expect(await revokeToken(env.DB, "real-user", theirRow.id)).toBe(false);
    expect(await resolveToken(env.DB, theirs.raw)).toEqual({ handle: "other-user" });

    expect(await revokeToken(env.DB, "real-user", myRow.id)).toBe(true);
    expect(await resolveToken(env.DB, mine.raw)).toBeNull();
    expect(await listTokens(env.DB, "real-user")).toEqual([]);
    expect(await revokeToken(env.DB, "real-user", myRow.id)).toBe(true); // idempotent
  });
});

describe("GET /auth/mcp-tokens · POST /auth/mcp-tokens/:id/revoke", () => {
  const get = (cookie: string) => app.request("/auth/mcp-tokens", { headers: { cookie } }, env);
  const post = (path: string, cookie: string) => app.request(path, { method: "POST", headers: { cookie } }, env);

  it("lists the caller's tokens, revokes one, 404s on another person's id and a junk id, 401s signed out", async () => {
    const me = await cookieFor("AndresL230");
    const other = await cookieFor("priya");
    const { token } = await (await post("/auth/mcp-token", me)).json() as { token: string };
    await post("/auth/mcp-token", other);

    const { tokens } = await (await get(me)).json() as { tokens: { id: number; hint: string | null }[] };
    expect(tokens).toHaveLength(1);
    expect(tokens[0].hint).toBe(token.slice(11, 15));
    expect(JSON.stringify(tokens)).not.toContain(token);

    expect((await post(`/auth/mcp-tokens/${tokens[0].id}/revoke`, other)).status).toBe(404);
    expect((await post("/auth/mcp-tokens/nope/revoke", me)).status).toBe(404);
    expect(await resolveToken(env.DB, token)).toEqual({ handle: "AndresL230" });

    expect((await post(`/auth/mcp-tokens/${tokens[0].id}/revoke`, me)).status).toBe(200);
    expect(await resolveToken(env.DB, token)).toBeNull();
    expect(((await (await get(me)).json()) as { tokens: unknown[] }).tokens).toEqual([]);
    expect((await get("")).status).toBe(401);
  });
});
