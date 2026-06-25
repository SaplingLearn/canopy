import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";

async function authedCookie(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

describe("GET /auth/me", () => {
  it("returns login, name, and org for an authenticated user", async () => {
    const cookie = await authedCookie("andres");
    const res = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { login: string; name: string | null; org: string };
    expect(body.login).toBe("andres");
    expect(body.name).toBe("andres");
    expect(body.org).toBe("SaplingLearn");
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/auth/me", {}, env);
    expect(res.status).toBe(401);
  });
});
