import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import type { IdentityTaskRow, PersonRow } from "@shared/rows";

describe("identity_tasks schema (0016)", () => {
  it("stores one task per login with pending status and null audit columns", async () => {
    await run(
      env.DB,
      `INSERT INTO identity_tasks (login, first_seen, status) VALUES (?, ?, 'pending')`,
      "mystery-dev",
      "2026-07-01T10:00:00Z"
    );
    const row = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = ?`, "mystery-dev");
    expect(row).toMatchObject({
      login: "mystery-dev",
      first_seen: "2026-07-01T10:00:00Z",
      status: "pending",
      resolved_at: null,
      resolved_by: null,
    });
  });

  it("login is the PK: INSERT OR IGNORE collapses a second task for the same login", async () => {
    await run(env.DB, `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES ('dup', '2026-07-01T10:00:00Z', 'pending')`);
    await run(env.DB, `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES ('dup', '2026-07-02T10:00:00Z', 'pending')`);
    const rows = await all<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'dup'`);
    expect(rows.length).toBe(1);
    expect(rows[0].first_seen).toBe("2026-07-01T10:00:00Z"); // the first sighting wins
  });

  // Sequential within this file: this test dirties people; the next asserts the
  // harness reset restored the 0012 seed. Guards Task 3's runtime writes from
  // leaking across tests.
  it("dirties the people map (setup for the reseed assertion below)", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('leaky-login', 'Leak')`);
    expect((await all<PersonRow>(env.DB, `SELECT * FROM people`)).length).toBe(5);
  });

  it("beforeEach resets people back to exactly the 0012 seed", async () => {
    const people = await all<PersonRow>(env.DB, `SELECT * FROM people ORDER BY login`);
    expect(people.length).toBe(4);
    expect(people.map((p) => p.login).sort()).toEqual(
      ["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "lpcooper-arch"].sort()
    );
    expect(await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'leaky-login'`)).toBeNull();
  });
});
