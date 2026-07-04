import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import type { Env } from "../src/env";
import type { Summarizer } from "../src/tools/summarize";
import {
  storePrSummary,
  storeIssueSummary,
  excerptSummary,
  SUMMARIZER_SYSTEM_PROMPT,
  ISSUE_SUMMARIZER_SYSTEM_PROMPT,
  workersAiPrSummarizer,
  workersAiIssueSummarizer,
} from "../src/tools/summarize";
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

  it("with no explicit summarizer, falls back through workersAiPrSummarizer(env.AI) to excerpt (no remote AI session in tests, never throws)", async () => {
    const res = await postWebhook("pull_request", prMerged);
    expect(res.status).toBe(200);
    const rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("excerpt");
  });
});

describe("SUMMARIZER_SYSTEM_PROMPT", () => {
  it("asks for 2-3 sentences of plain prose, not the old structured What changed/Why convention", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).not.toContain("**What changed:**");
    expect(SUMMARIZER_SYSTEM_PROMPT).not.toContain("**Why:**");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("2 to 3 sentences");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("no headings");
  });
});

describe("ISSUE_SUMMARIZER_SYSTEM_PROMPT", () => {
  it("asks for a plain restatement plus what needs doing only when the issue supports it", () => {
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toContain("2 to 3 sentences");
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toContain("never invent a next step");
  });
});

// Different Workers AI model families shape ai.run()'s resolved value
// differently: some return the classic flat {response: string}, others
// (e.g. gemma-4-26b-a4b-it) return an OpenAI-style Chat Completions shape
// ({choices: [{message: {content: string}}]}). workersAiPrSummarizer must
// handle both without throwing, since a mismatch here silently produces
// model:'excerpt' forever — exactly the bug this test suite exists to catch.
describe("workersAiPrSummarizer — response shape handling", () => {
  it("extracts text from the classic flat {response} shape", async () => {
    const fakeAi = { run: async () => ({ response: "**What changed:** Fixed the bug." }) } as unknown as Ai;
    const result = await workersAiPrSummarizer(fakeAi).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBe("**What changed:** Fixed the bug.");
  });

  it("extracts text from the OpenAI-style {choices[0].message.content} shape", async () => {
    const fakeAi = {
      run: async () => ({ choices: [{ message: { role: "assistant", content: "**What changed:** Fixed the bug." } }] }),
    } as unknown as Ai;
    const result = await workersAiPrSummarizer(fakeAi).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBe("**What changed:** Fixed the bug.");
  });

  it("returns null when neither shape is present", async () => {
    const fakeAi = { run: async () => ({ unexpected: "shape" }) } as unknown as Ai;
    const result = await workersAiPrSummarizer(fakeAi).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });

  it("returns null when ai.run throws", async () => {
    const fakeAi = {
      run: async () => {
        throw new Error("model not found");
      },
    } as unknown as Ai;
    const result = await workersAiPrSummarizer(fakeAi).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });

  it("returns null for an empty/whitespace-only response", async () => {
    const fakeAi = { run: async () => ({ response: "   " }) } as unknown as Ai;
    const result = await workersAiPrSummarizer(fakeAi).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });
});

describe("storeIssueSummary", () => {
  it("stores the stub summarizer's summary under its own model id", async () => {
    const stub: Summarizer = { model: "stub", summarize: async () => "What it is and what to do." };
    const row = await storeIssueSummary(env.DB, stub, { issue_number: 1, title: "Some issue", body: "Some body" });
    expect(row.summary).toBe("What it is and what to do.");
    expect(row.model).toBe("stub");
    expect(row.issue_number).toBe(1);

    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 1);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("What it is and what to do.");
  });

  it("falls back to excerptSummary (model:'excerpt') when the summarizer returns null, and never throws", async () => {
    const nullStub: Summarizer = { model: "stub", summarize: async () => null };
    const row = await storeIssueSummary(env.DB, nullStub, { issue_number: 2, title: "Another issue", body: "Body text here" });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe(excerptSummary("Another issue", "Body text here"));
  });

  it("falls back to excerptSummary when the summarizer throws, and never throws", async () => {
    const throwingStub: Summarizer = {
      model: "stub",
      summarize: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      storeIssueSummary(env.DB, throwingStub, { issue_number: 3, title: "Third issue", body: "" })
    ).resolves.not.toThrow();
    const row = await storeIssueSummary(env.DB, throwingStub, { issue_number: 3, title: "Third issue", body: "" });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Third issue"); // empty body → title
  });

  it("falls back to excerptSummary when no summarizer is provided (null)", async () => {
    const row = await storeIssueSummary(env.DB, null, { issue_number: 4, title: "Fourth issue", body: "   " });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Fourth issue"); // whitespace-only body collapses to empty → title
  });

  it("INSERT OR REPLACE overwrites the prior summary for the same issue_number", async () => {
    const s1: Summarizer = { model: "m1", summarize: async () => "First summary" };
    await storeIssueSummary(env.DB, s1, { issue_number: 5, title: "Issue", body: "body" });
    const s2: Summarizer = { model: "m2", summarize: async () => "Second summary" };
    await storeIssueSummary(env.DB, s2, { issue_number: 5, title: "Issue", body: "body" });
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 5);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Second summary");
    expect(rows[0].model).toBe("m2");
  });
});
