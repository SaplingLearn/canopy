import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";

// Seal a session cookie for `login` (mirrors test/dashboard-route.test.ts:9-15).
async function cookieFor(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

describe("POST /admin/backfill (session- + admin-gated)", () => {
  it("401s without a session", async () => {
    const res = await app.request("/admin/backfill", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin principal", async () => {
    const res = await app.request(
      "/admin/backfill",
      { method: "POST", headers: { cookie: await cookieFor("not-admin") } },
      env
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin only" });
  });

  it("passes the admin gate and 503s when the service token is unset (proves wiring, no network)", async () => {
    // ADMIN_LOGINS binds "admin-user" in vitest.config.ts, so this login clears
    // isAdmin. GITHUB_SERVICE_TOKEN is a secret never set in tests, so runBackfill
    // returns ok:false BEFORE any GitHub fetch → 503 with the config error.
    const res = await app.request(
      "/admin/backfill",
      { method: "POST", headers: { cookie: await cookieFor("admin-user") } },
      env
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "service token or repo not configured" });
  });
});
