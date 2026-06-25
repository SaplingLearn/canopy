import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { encryptSecret, decryptSecret } from "../src/auth/crypto";
import { storeToken, getStoredToken } from "../src/auth/github";
import { run, nowIso, all } from "../src/db";
import { IngestPayload } from "@shared/contract";
import { ingestMilestoneProposal, consume } from "../src/consumer";
import type { MilestoneProposalRow, MilestoneRow, NeedsTriageRow } from "@shared/rows";

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
