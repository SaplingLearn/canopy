import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createSession, getSessionUser, deleteSession } from "../src/auth/session";
import { run } from "../src/db";

async function seedUser(login: string) {
  await env.DB.prepare(`INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`)
    .bind(login, login, "2026-01-01T00:00:00Z").run();
}

describe("sessions", () => {
  it("creates a session and resolves it to the user", async () => {
    await seedUser("real-user");
    const { id } = await createSession(env.DB, "real-user");
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(await getSessionUser(env.DB, id)).toBe("real-user");
  });

  it("returns null for an unknown session id", async () => {
    expect(await getSessionUser(env.DB, "nope")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    await seedUser("real-user");
    await run(env.DB,
      `INSERT INTO sessions (id, user, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      "expired-id", "real-user", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z");
    expect(await getSessionUser(env.DB, "expired-id")).toBeNull();
  });

  it("deletes a session (revocation)", async () => {
    await seedUser("real-user");
    const { id } = await createSession(env.DB, "real-user");
    await deleteSession(env.DB, id);
    expect(await getSessionUser(env.DB, id)).toBeNull();
  });
});
