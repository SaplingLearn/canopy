import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { ingestEvent, consume } from "../src/consumer";
import type { EventRow } from "@shared/rows";
import { IngestPayload, type CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:42:merged",
  event_type: "pr_merged",
  ref_number: 42,
  subject_login: "AndresL230",
  raw: JSON.stringify({ pr: { number: 42, title: "t", body: "b" } }),
  provenance: "webhook",
  occurred_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("ingestEvent gate arm", () => {
  it("writes once; an identical semantic_key is unchanged (INSERT OR IGNORE)", async () => {
    expect((await ingestEvent(env.DB, ev(), "github-webhook")).outcome).toBe("written");
    expect((await ingestEvent(env.DB, ev(), "github-webhook")).outcome).toBe("unchanged");
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1);
    expect(rows[0].subject_login).toBe("AndresL230");   // subject preserved
    expect(rows[0].recorded_by).toBe("github-webhook"); // writer = principal
  });

  it("consume() carries an events[] arm through the same gate, replay-safe", async () => {
    const payload = {
      session: { id: "evt-S1", author: "spoof", ended_at: "2026-07-01T10:00:00Z", skill_version: "2.0" },
      events: [ev(), ev({ semantic_key: "gh:pr:43:closed", event_type: "pr_closed", ref_number: 43 })],
    };
    const r1 = await consume(env.DB, IngestPayload.parse(structuredClone(payload)), { login: "AndresL230" });
    expect(r1.events).toEqual({ written: 2, unchanged: 0 });
    const r2 = await consume(env.DB, IngestPayload.parse(structuredClone(payload)), { login: "AndresL230" });
    expect(r2.events).toEqual({ written: 0, unchanged: 2 }); // replay ledger drop
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(2);
  });
});
