import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { encryptSecret, decryptSecret } from "../src/auth/crypto";
import { storeToken, getStoredToken } from "../src/auth/github";
import { run, nowIso, all, first } from "../src/db";
import { IngestPayload } from "@shared/contract";
import { ingestMilestoneProposal, consume } from "../src/consumer";
import type { MilestoneProposalRow, MilestoneRow, NeedsTriageRow } from "@shared/rows";
import { list_roadmap, fetchMilestoneProgress } from "../src/tools/roadmap";
import { promote_milestone_proposal, complete_milestone, stage_milestone_proposal } from "../src/tools/writes";

const SECRET = "test-cookie-secret";

describe("AES-GCM secret sealing", () => {
  it("round-trips a value and fails closed on a wrong secret / garbage", async () => {
    const sealed = await encryptSecret("gho_secret_token", SECRET);
    expect(sealed).not.toContain("gho_secret_token");
    expect(await decryptSecret(sealed, SECRET)).toBe("gho_secret_token");
    expect(await decryptSecret(sealed, "wrong-secret")).toBeNull();
    expect(await decryptSecret("not-valid", SECRET)).toBeNull();
  });
});

describe("GitHub token retention", () => {
  it("stores a sealed token and reads it back for the principal; null when absent", async () => {
    await run(env.DB, `INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`, "andres", null, nowIso());
    expect(await getStoredToken(env.DB, "andres", SECRET)).toBeNull();

    await storeToken(env.DB, "andres", "gho_live_token", SECRET);
    expect(await getStoredToken(env.DB, "andres", SECRET)).toBe("gho_live_token");
    expect(await getStoredToken(env.DB, "nobody", SECRET)).toBeNull();
  });
});

const sessionMeta = { author: "x", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" };

describe("milestone proposal gate", () => {
  it("stages a valid proposal; it is NOT a live milestone until promoted", async () => {
    const r = await ingestMilestoneProposal(
      env.DB,
      { title: "GA", target_date: "2026-09-01", status: "in_progress", github_ref: [1, 2], change_summary: "kickoff", confidence: "high" },
      "andres"
    );
    expect(r.outcome).toBe("written");

    const staged = await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`);
    expect(staged.length).toBe(1);
    expect(staged[0].staged_status).toBe("staged");
    expect(JSON.parse(staged[0].github_ref!)).toEqual([1, 2]);

    const live = await all<MilestoneRow>(env.DB, `SELECT * FROM milestones`);
    expect(live.length).toBe(0); // not live until the human promote route runs
  });

  it("routes a 'done'-status proposal to triage (completion is a human action)", async () => {
    const r = await ingestMilestoneProposal(
      env.DB,
      { title: "Done?", target_date: "2026-09-01", status: "done", change_summary: "s", confidence: "high" },
      "andres"
    );
    expect(r.outcome).toBe("triaged");
    expect(await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`)).toHaveLength(0);
    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage[0].reason).toContain("completion");
  });

  it("routes a low-confidence proposal to triage", async () => {
    const r = await ingestMilestoneProposal(
      env.DB,
      { title: "Maybe", target_date: "2026-09-01", status: "upcoming", change_summary: "s", confidence: "low" },
      "andres"
    );
    expect(r.outcome).toBe("triaged");
    expect(await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`)).toHaveLength(0);
  });

  it("/ingest funnels milestone_proposals through the same gate and stages them", async () => {
    const payload = IngestPayload.parse({
      session: sessionMeta,
      milestone_proposals: [
        { title: "GA", target_date: "2026-09-01", status: "upcoming", change_summary: "s", confidence: "high" },
      ],
    });
    const result = await consume(env.DB, payload, { login: "andres" });
    expect(result.milestones).toBe(1);
    const staged = await all<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals`);
    expect(staged.length).toBe(1);
    expect(staged[0].created_by).toBe("andres"); // author from principal, not session
  });
});

// A stub `fetch` returning canned GitHub issue/milestone JSON, keyed by URL.
function stubFetch(map: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(map).find((k) => u.endsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fetchMilestoneProgress", () => {
  it("counts closed vs total across an issue-number array", async () => {
    const fetchImpl = stubFetch({ "/issues/1": { state: "closed" }, "/issues/2": { state: "open" } });
    const p = await fetchMilestoneProgress({ token: "t", repo: "o/r", ref: "[1,2]", fetchImpl });
    expect(p).toEqual({ closed: 1, total: 2 });
  });

  it("reads counts directly from a milestone object", async () => {
    const fetchImpl = stubFetch({ "/milestones/5": { open_issues: 3, closed_issues: 7, state: "open" } });
    const p = await fetchMilestoneProgress({ token: "t", repo: "o/r", ref: "5", fetchImpl });
    expect(p).toEqual({ closed: 7, total: 10 });
  });

  it("falls back to null on a non-OK GitHub response (expired/revoked token), never throws", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const p = await fetchMilestoneProgress({ token: "stale", repo: "o/r", ref: "[1]", fetchImpl });
    expect(p).toBeNull();
  });
});

describe("promote_milestone_proposal + complete_milestone", () => {
  it("promotes a staged proposal into a live milestone (and not before)", async () => {
    const pid = await stage_milestone_proposal(
      env.DB,
      { title: "GA", target_date: "2026-09-01", status: "in_progress", github_ref: [1, 2], change_summary: "s", confidence: "high" },
      "andres"
    );
    expect(await all<MilestoneRow>(env.DB, `SELECT * FROM milestones`)).toHaveLength(0);

    const m = await promote_milestone_proposal(env.DB, pid, "andres");
    expect(m.status).toBe("in_progress");
    expect(m.title).toBe("GA");

    const proposal = await first<MilestoneProposalRow>(env.DB, `SELECT * FROM milestone_proposals WHERE id = ?`, pid);
    expect(proposal?.staged_status).toBe("promoted");
    await expect(promote_milestone_proposal(env.DB, pid, "andres")).rejects.toThrow(); // no double-promote
  });

  it("complete_milestone flips a live milestone to 'done'; rejects missing/already-done", async () => {
    const pid = await stage_milestone_proposal(
      env.DB,
      { title: "GA", target_date: "2026-09-01", status: "in_progress", change_summary: "s", confidence: "high" },
      "andres"
    );
    const m = await promote_milestone_proposal(env.DB, pid, "andres");
    const done = await complete_milestone(env.DB, m.id);
    expect(done.status).toBe("done");
    const row = await first<MilestoneRow>(env.DB, `SELECT * FROM milestones WHERE id = ?`, m.id);
    expect(row?.status).toBe("done");
    await expect(complete_milestone(env.DB, m.id)).rejects.toThrow();   // already done
    await expect(complete_milestone(env.DB, 9999)).rejects.toThrow();   // missing
  });
});

describe("list_roadmap", () => {
  it("computes progress from a MOCKED GitHub response, orders by target_date, and stores nothing; all-closed does NOT auto-flip", async () => {
    // Two live milestones, the earlier-dated one second to prove ordering.
    const p1 = await stage_milestone_proposal(env.DB, { title: "Later", target_date: "2026-12-01", status: "upcoming", github_ref: [1], change_summary: "s", confidence: "high" }, "andres");
    const p2 = await stage_milestone_proposal(env.DB, { title: "Sooner", target_date: "2026-07-01", status: "in_progress", github_ref: [1, 2], change_summary: "s", confidence: "high" }, "andres");
    const mLater = await promote_milestone_proposal(env.DB, p1, "andres");
    const mSooner = await promote_milestone_proposal(env.DB, p2, "andres");

    // All linked issues closed.
    const fetchImpl = stubFetch({ "/issues/1": { state: "closed" }, "/issues/2": { state: "closed" } });
    const roadmap = await list_roadmap(env.DB, { token: "t", repo: "o/r", fetchImpl });

    expect(roadmap.map((m) => m.title)).toEqual(["Sooner", "Later"]); // target_date ASC
    expect(roadmap.find((m) => m.title === "Sooner")!.progress).toEqual({ closed: 2, total: 2 });

    // 100% closed must NOT flip status — only the explicit complete route does that.
    expect(roadmap.find((m) => m.title === "Sooner")!.status).toBe("in_progress");
    const storedSooner = await first<MilestoneRow>(env.DB, `SELECT * FROM milestones WHERE id = ?`, mSooner.id);
    expect(storedSooner?.status).toBe("in_progress"); // nothing written by the read
    expect(storedSooner?.updated_at).toBe(mSooner.updated_at);
    void mLater;
  });

  it("returns milestones WITHOUT progress when no token is available (fallback seam)", async () => {
    const pid = await stage_milestone_proposal(env.DB, { title: "GA", target_date: "2026-09-01", status: "upcoming", github_ref: [1], change_summary: "s", confidence: "high" }, "andres");
    await promote_milestone_proposal(env.DB, pid, "andres");
    const roadmap = await list_roadmap(env.DB, { token: null, repo: "o/r" });
    expect(roadmap).toHaveLength(1);
    expect(roadmap[0].progress).toBeNull();
  });
});
