/**
 * canopy-email.md §7 (Addresses): the teammate email is seeded at first login
 * from GET /user/emails (primary + verified), written only when the row has no
 * address yet, never overwriting a user- or admin-edited value.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first } from "../src/db";
import { getPrimaryEmail } from "../src/auth/github";
import { recordLogin } from "../src/auth/users";
import type { UserRow } from "@shared/rows";

const jsonFetch = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("getPrimaryEmail", () => {
  it("returns the primary + verified address even when the profile email is private (noreply alias present)", async () => {
    const f = jsonFetch(200, [
      { email: "12345+jose@users.noreply.github.com", primary: false, verified: true, visibility: null },
      { email: "jose@example.com", primary: true, verified: true, visibility: "private" },
    ]);
    expect(await getPrimaryEmail("tok", f)).toBe("jose@example.com");
  });
  it("ignores a primary address that is not verified", async () => {
    const f = jsonFetch(200, [{ email: "x@example.com", primary: true, verified: false }]);
    expect(await getPrimaryEmail("tok", f)).toBeNull();
  });
  it("returns null on a non-2xx response", async () => {
    expect(await getPrimaryEmail("tok", jsonFetch(403, { message: "scope" }))).toBeNull();
  });
});

describe("recordLogin — email written on first login only", () => {
  const gh = { login: "jose", name: "Jose", avatar_url: "https://a/img.png" };
  const row = () => first<UserRow>(env.DB, `SELECT * FROM users WHERE github_login = 'jose'`);

  it("first login seeds a non-null email", async () => {
    await recordLogin(env.DB, gh, "jose@example.com");
    expect((await row())!.email).toBe("jose@example.com");
  });
  it("a later login never overwrites an existing address, even if GitHub now reports a different one", async () => {
    await recordLogin(env.DB, gh, "jose@example.com");
    await env.DB.prepare(`UPDATE users SET email = 'edited@example.com' WHERE github_login = 'jose'`).run();
    await recordLogin(env.DB, { ...gh, name: "Jose G" }, "new@github.example");
    const r = (await row())!;
    expect(r.email).toBe("edited@example.com");
    expect(r.name).toBe("Jose G"); // name/avatar still refresh on every login
  });
  it("a login with no address available leaves the column null, and a later login with one fills it", async () => {
    await recordLogin(env.DB, gh, null);
    expect((await row())!.email).toBeNull();
    await recordLogin(env.DB, gh, "jose@example.com");
    expect((await row())!.email).toBe("jose@example.com");
  });
});
