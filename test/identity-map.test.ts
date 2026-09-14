import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { map_identity } from "../src/tools/writes";
import { seedPerson } from "./helpers/persons";
import type { IdentityTaskRow, IdentityRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:7:merged", event_type: "pr_merged", ref_number: 7, subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "t", body: "b" } }), provenance: "webhook", occurred_at: "2026-07-01T10:00:00Z", ...over,
});

describe("map_identity — the identities table's human write path", () => {
  it("links the login to an existing person and soft-resolves the task", async () => {
    await seedPerson("casey");
    await ingestEvent(env.DB, ev(), "github-webhook");
    const res = await map_identity(env.DB, "mystery-dev", "casey", "andres");
    expect(res).toEqual({ login: "mystery-dev", person: "casey", status: "resolved" });
    const id = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'github' AND subject = 'mystery-dev'`);
    expect(id?.person).toBe("casey");
    expect(id?.linked_by).toBe("andres");
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task?.status).toBe("resolved");
    expect(task?.resolved_by).toBe("andres");
  });
  it("double-map is idempotent-safe: the first mapping stands", async () => {
    await seedPerson("casey"); await seedPerson("other");
    await ingestEvent(env.DB, ev(), "github-webhook");
    await map_identity(env.DB, "mystery-dev", "casey", "andres");
    const second = await map_identity(env.DB, "mystery-dev", "other", "jose");
    expect(second).toEqual({ login: "mystery-dev", person: "casey", status: "resolved" });
    expect((await all(env.DB, `SELECT * FROM identities WHERE subject = 'mystery-dev'`)).length).toBe(1);
  });
  it("throws on a login with no identity task, and on an unknown person", async () => {
    await expect(map_identity(env.DB, "nobody-here", "casey", "andres")).rejects.toThrow("no such identity task: nobody-here");
    await ingestEvent(env.DB, ev(), "github-webhook");
    await expect(map_identity(env.DB, "mystery-dev", "ghost", "andres")).rejects.toThrow("no such person: ghost");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'mystery-dev'`)).toBeNull();
  });
  it("a login already linked never raises a task", async () => {
    await ingestEvent(env.DB, ev({ subject_login: "AndresL230", semantic_key: "gh:pr:8:merged", ref_number: 8 }), "github-webhook");
    expect(await first(env.DB, `SELECT 1 AS x FROM identity_tasks WHERE login = 'AndresL230'`)).toBeNull();
  });
});
