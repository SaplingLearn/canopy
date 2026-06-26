import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";

async function authedCookie(login: string, avatarUrl?: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, avatar_url, created_at) VALUES (?, ?, ?, ?)`
  ).bind(login, login, avatarUrl ?? null, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

describe("GET /auth/me", () => {
  it("returns login, name, org, and null avatar_url when not set", async () => {
    const cookie = await authedCookie("andres");
    const res = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { login: string; name: string | null; avatar_url: string | null; org: string };
    expect(body.login).toBe("andres");
    expect(body.name).toBe("andres");
    expect(body.avatar_url).toBeNull();
    expect(body.org).toBe("SaplingLearn");
  });

  it("returns avatar_url when stored", async () => {
    const url = "https://avatars.githubusercontent.com/u/12345?v=4";
    const cookie = await authedCookie("jose", url);
    const res = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { login: string; name: string | null; avatar_url: string | null; org: string };
    expect(body.login).toBe("jose");
    expect(body.avatar_url).toBe(url);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/auth/me", {}, env);
    expect(res.status).toBe(401);
  });
});
