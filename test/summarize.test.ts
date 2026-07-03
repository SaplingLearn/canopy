import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";
import type { PrSummaryRow } from "@shared/rows";
import type { Env } from "../src/env";
import type { Summarizer } from "../src/tools/summarize";
import { storePrSummary, excerptSummary } from "../src/tools/summarize";
import { handleGithubWebhook } from "../src/webhook";
import prMerged from "./fixtures/gh-pr-merged.json";
import issueAssigned from "./fixtures/gh-issue-assigned.json";

const SECRET = "test-webhook-secret"; // matches vitest.config.ts binding

// pr_summaries.semantic_key REFERENCES events(semantic_key) — in real usage
// storePrSummary only ever runs after ingestEvent has written the events row
// (the webhook seam). Direct storePrSummary tests below seed a minimal events
// row first so the FK is satisfied, mirroring that real call order.
async function seedEvent(semanticKey: string, prNumber: number): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, 'pr_merged', ?, 'someone', '{}', 'webhook', NULL, ?, 'github-webhook')`,
    semanticKey,
    prNumber,
    nowIso()
  );
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function req(body: string, headers: Record<string, string>): Request {
  return new Request("https://x/webhook/github", { method: "POST", headers, body });
}

async function postWebhook(
  eventName: string,
  payload: unknown,
  opts?: { summarizer?: Summarizer | null },
  e: Env = env
): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = await sign(SECRET, body);
  return handleGithubWebhook(
    req(body, { "x-github-event": eventName, "x-hub-signature-256": sig, "content-type": "application/json" }),
    e,
    opts
  );
}

describe("storePrSummary", () => {
  it("stores the stub summarizer's summary under its own model id", async () => {
    await seedEvent("gh:pr:1:merged", 1);
    const stub: Summarizer = { model: "stub", summarize: async () => "- did the thing" };
    const row = await storePrSummary(env.DB, stub, {
      semantic_key: "gh:pr:1:merged",
      pr_number: 1,
      title: "Some PR",
      body: "Some body",
    });
    expect(row.summary).toBe("- did the thing");
    expect(row.model).toBe("stub");
    expect(row.semantic_key).toBe("gh:pr:1:merged");

    const rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:1:merged");
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("- did the thing");
    expect(rows[0].model).toBe("stub");
  });

  it("falls back to excerptSummary (model:'excerpt') when the summarizer returns null, and never throws", async () => {
    await seedEvent("gh:pr:2:merged", 2);
    const nullStub: Summarizer = { model: "stub", summarize: async () => null };
    const row = await storePrSummary(env.DB, nullStub, {
      semantic_key: "gh:pr:2:merged",
      pr_number: 2,
      title: "Another PR",
      body: "Body text here",
    });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe(excerptSummary("Another PR", "Body text here"));
  });

  it("falls back to excerptSummary when the summarizer throws, and never throws", async () => {
    await seedEvent("gh:pr:3:merged", 3);
    const throwingStub: Summarizer = {
      model: "stub",
      summarize: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      storePrSummary(env.DB, throwingStub, {
        semantic_key: "gh:pr:3:merged",
        pr_number: 3,
        title: "Third PR",
        body: "",
      })
    ).resolves.not.toThrow();
    const row = await storePrSummary(env.DB, throwingStub, {
      semantic_key: "gh:pr:3:merged",
      pr_number: 3,
      title: "Third PR",
      body: "",
    });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Third PR"); // empty body → title
  });

  it("falls back to excerptSummary when no summarizer is provided (null)", async () => {
    await seedEvent("gh:pr:4:merged", 4);
    const row = await storePrSummary(env.DB, null, {
      semantic_key: "gh:pr:4:merged",
      pr_number: 4,
      title: "Fourth PR",
      body: "   ",
    });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Fourth PR"); // whitespace-only body collapses to empty → title
  });
});

describe("excerptSummary", () => {
  it("returns the title when the body is empty", () => {
    expect(excerptSummary("A Title", "")).toBe("A Title");
  });

  it("collapses whitespace and returns short bodies verbatim (no truncation suffix)", () => {
    expect(excerptSummary("Title", "line one\n\nline   two")).toBe("line one line two");
  });

  it("truncates at exactly 280 chars with no suffix at the boundary", () => {
    const body = "a".repeat(280);
    const result = excerptSummary("Title", body);
    expect(result).toBe(body);
    expect(result.length).toBe(280);
    expect(result.endsWith("…")).toBe(false);
  });

  it("truncates past 280 chars and suffixes …", () => {
    const body = "a".repeat(281);
    const result = excerptSummary("Title", body);
    expect(result).toBe("a".repeat(280) + "…");
  });
});

describe("webhook → summarize wiring", () => {
  it("pr-merged fixture + stub summarizer → one pr_summaries row keyed gh:pr:42:merged; replay writes no second row", async () => {
    const stub: Summarizer = { model: "stub", summarize: async () => "- did the thing" };
    const res = await postWebhook("pull_request", prMerged, { summarizer: stub });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0 });

    let rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
    expect(rows[0].pr_number).toBe(42);
    expect(rows[0].model).toBe("stub");
    expect(rows[0].summary).toBe("- did the thing");

    // Replay: the event is unchanged (INSERT OR IGNORE drops it) → the seam never
    // re-runs, so still exactly one pr_summaries row.
    const res2 = await postWebhook("pull_request", prMerged, { summarizer: stub });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, captured: 0, unchanged: 1 });
    rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
  });

  it("issue events never reach storePrSummary — zero pr_summaries rows", async () => {
    const stub: Summarizer = { model: "stub", summarize: async () => "- should never be called" };
    const res = await postWebhook("issues", issueAssigned, { summarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries`);
    expect(rows.length).toBe(0);
  });

  it("with no explicit summarizer, falls back through workersAiSummarizer(env.AI) to excerpt (no remote AI session in tests, never throws)", async () => {
    const res = await postWebhook("pull_request", prMerged);
    expect(res.status).toBe(200);
    const rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("excerpt");
  });
});
