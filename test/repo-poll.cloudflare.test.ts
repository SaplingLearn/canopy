/**
 * Task 16 — Cloudflare Workers analytics (source K).
 *
 * `pollCloudflare` writes hourly `cf_requests` / `cf_errors` per frontend Worker
 * for the last 3 COMPLETE hours; `getRepoDashboard` projects the Usage tab's
 * requests / error rate and the Cloudflare panel from ONE read of those rows.
 * The fetch is stubbed at the Response level; every assertion is on D1 rows or
 * on the projection built from them.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pollCloudflare } from "../src/repo/poll";
import { putMetric } from "../src/repo/store";
import { getRepoDashboard } from "../src/tools/repo";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:05:00Z");
const HOUR = 3_600_000;
const CF = { token: "t", accountId: "acct" };

interface CfRow { dimensions: unknown; sum: unknown }
const cfBody = (rows: CfRow[]) => ({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } });
const hourRow = (at: string, requests: unknown, errors: unknown): CfRow => ({ dimensions: { datetimeHour: at }, sum: { requests, errors } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stored = () => all<{ metric: string; env: string; part: string; value: number; at: string }>(env.DB,
  `SELECT metric, env, part, value, at FROM repo_metrics WHERE metric LIKE 'cf_%' ORDER BY env, metric, at`);

describe("pollCloudflare", () => {
  it("stores hourly requests and errors per frontend Worker", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toBe("https://api.cloudflare.com/client/v4/graphql");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer t");
      const sent = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      seen.push(sent.variables.s);
      // The last 3 COMPLETE hours: `to` is the floor of the current hour.
      expect(sent.variables).toMatchObject({ a: "acct", from: "2026-09-20T09:00:00.000Z", to: "2026-09-20T12:00:00.000Z" });
      // Cloudflare's schema spells the scalar `string`, lowercase — `String!` is rejected.
      expect(sent.query).toContain("$a: string!");
      expect(sent.query).toContain("$s: string!");
      expect(sent.query).toContain("$from: Time!");
      expect(sent.query).not.toContain("String");
      expect(sent.query).toContain("workersInvocationsAdaptive");
      return json(cfBody([hourRow("2026-09-20T10:00:00Z", 500, 12), hourRow("2026-09-20T11:00:00Z", 640, 3)]));
    }) as typeof fetch;
    await pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl);
    expect(seen).toEqual(["frontend-staging", "frontend"]);
    expect((await stored()).filter((r) => r.env === "staging")).toEqual([
      { metric: "cf_errors", env: "staging", part: "frontend", value: 12, at: "2026-09-20T10:00:00.000Z" },
      { metric: "cf_errors", env: "staging", part: "frontend", value: 3, at: "2026-09-20T11:00:00.000Z" },
      { metric: "cf_requests", env: "staging", part: "frontend", value: 500, at: "2026-09-20T10:00:00.000Z" },
      { metric: "cf_requests", env: "staging", part: "frontend", value: 640, at: "2026-09-20T11:00:00.000Z" },
    ]);
    expect((await stored()).filter((r) => r.env === "production")).toHaveLength(4);
  });

  it("the overlap is a no-op: a second poll of the same hours writes nothing new, and the first value stands", async () => {
    const at = "2026-09-20T11:00:00Z";
    await pollCloudflare(env.DB, CF, [ENVS[0]], NOW, (async () => json(cfBody([hourRow(at, 640, 3)]))) as typeof fetch);
    await pollCloudflare(env.DB, CF, [ENVS[0]], NOW, (async () => json(cfBody([hourRow(at, 999, 9)]))) as typeof fetch);
    expect((await stored()).map((r) => [r.metric, r.value])).toEqual([["cf_errors", 3], ["cf_requests", 640]]);
  });

  it("a rejected token writes nothing and does not throw", async () => {
    const fetchImpl = (async () => json({ errors: [{ message: "unauthorized" }] }, 403)) as typeof fetch;
    await expect(pollCloudflare(env.DB, { token: "bad", accountId: "acct" }, ENVS, NOW, fetchImpl)).resolves.toBeUndefined();
    expect(await stored()).toEqual([]);
  });

  it("a thrown fetch writes nothing and does not throw", async () => {
    const fetchImpl = (async () => { throw new Error("connect timeout"); }) as typeof fetch;
    await expect(pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl)).resolves.toBeUndefined();
    expect(await stored()).toEqual([]);
  });

  // A GraphQL error arrives with HTTP 200: `data` beside a non-empty `errors`
  // must not be read — and one environment's failure must not cost the next.
  it("a 200 body carrying `errors` is a failure for THAT environment only", async () => {
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const s = (JSON.parse(String(init?.body)) as { variables: { s: string } }).variables.s;
      return s === "frontend-staging"
        ? json({ errors: [{ message: "unknown field" }], ...cfBody([hourRow("2026-09-20T11:00:00Z", 1, 1)]) })
        : json(cfBody([hourRow("2026-09-20T11:00:00Z", 640, 3)]));
    }) as typeof fetch;
    await expect(pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl)).resolves.toBeUndefined();
    expect((await stored()).map((r) => [r.env, r.metric, r.value])).toEqual([["production", "cf_errors", 3], ["production", "cf_requests", 640]]);
  });

  // `datetime_leq: to` is INCLUSIVE, so the current (incomplete) hour's bucket can
  // come back. INSERT OR IGNORE would make that partial count PERMANENT.
  it("skips the bucket AT `to` — the current, incomplete hour is never stored", async () => {
    const fetchImpl = (async () => json(cfBody([
      hourRow("2026-09-20T11:00:00Z", 640, 3),
      hourRow("2026-09-20T12:00:00Z", 7, 0),  // the hour in progress at NOW (12:05)
      hourRow("2026-09-20T13:00:00Z", 1, 0),  // a clock ahead of ours — not complete either
    ]))) as typeof fetch;
    await pollCloudflare(env.DB, CF, [ENVS[0]], NOW, fetchImpl);
    expect((await stored()).map((r) => r.at)).toEqual(["2026-09-20T11:00:00.000Z", "2026-09-20T11:00:00.000Z"]);
  });

  it("skips a malformed row without losing the rows after it, and never stores NaN", async () => {
    const fetchImpl = (async () => json(cfBody([
      hourRow("not a date", 5, 0),
      hourRow("2026-09-20T09:00:00Z", -4, 0),
      hourRow("2026-09-20T09:00:00Z", 10, "many"),
      hourRow("2026-09-20T09:00:00Z", null, null),
      { dimensions: null, sum: null },
      { dimensions: { datetimeHour: "2026-09-20T09:00:00Z" }, sum: null },
      hourRow("2026-09-20T10:00:00Z", 500, 12),
    ]))) as typeof fetch;
    await expect(pollCloudflare(env.DB, CF, [ENVS[0]], NOW, fetchImpl)).resolves.toBeUndefined();
    expect((await stored()).map((r) => [r.metric, r.value, r.at])).toEqual([
      ["cf_errors", 12, "2026-09-20T10:00:00.000Z"], ["cf_requests", 500, "2026-09-20T10:00:00.000Z"],
    ]);
  });

  it("a body with no accounts (wrong account id) writes nothing and does not throw", async () => {
    const fetchImpl = (async () => json({ data: { viewer: { accounts: [] } } })) as typeof fetch;
    await expect(pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl)).resolves.toBeUndefined();
    expect(await stored()).toEqual([]);
  });
});

// ── the projection ───────────────────────────────────────────────────────────
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };
/** The start of the hour `h` complete hours before NOW's own (12:00): h=1 → 11:00. */
const hoursBack = (h: number) => new Date(Date.parse("2026-09-20T12:00:00Z") - h * HOUR).toISOString();
const point = async (envKey: string, at: string, requests: number, errors: number) => {
  await putMetric(env.DB, { metric: "cf_requests", env: envKey, part: "frontend", value: requests, at });
  await putMetric(env.DB, { metric: "cf_errors", env: envKey, part: "frontend", value: errors, at });
};

describe("getRepoDashboard — usage and Cloudflare from cf_* metrics", () => {
  it("nothing captured → both sections not_connected", async () => {
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(d.usage.status).toBe("not_connected");
    expect(d.cloudflare.status).toBe("not_connected");
  });

  it("sums requests, derives the error rate, and leaves active users unconnected", async () => {
    await point("staging", hoursBack(3), 1000, 30);
    await point("staging", hoursBack(1), 500, 0);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const [staging, production] = ok(d.usage)["24h"];
    expect(staging).toMatchObject({ name: "staging", host: "staging.saplinglearn.com", users: null });
    expect(staging.requests).toMatchObject({ value: "1.5K", tone: "neutral" });
    expect(staging.errorRate).toMatchObject({ value: "2.00%", tone: "warn" });
    // Never guess: production has no point in ANY range — null, not "0".
    expect(production).toMatchObject({ name: "production", requests: null, errorRate: null, users: null });
    expect(ok(d.cloudflare)["24h"]).toEqual([
      { env: "staging", label: "Workers requests", value: "1.5K" },
      { env: "staging", label: "Workers errors", value: "30" },
    ]);
  });

  // A quiet hour has NO row (Cloudflare returns only hours with invocations), so
  // the series is zero-filled — but only from the first captured point: before
  // capture began the value is unknown, not zero.
  it("zero-fills a quiet hour between captured ones, and nothing before capture began", async () => {
    await point("staging", hoursBack(4), 100, 10);
    await point("staging", hoursBack(1), 300, 0);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const [staging] = ok(d.usage)["24h"];
    expect(staging.requests?.trend).toEqual([100, 0, 0, 300]);
    expect(staging.errorRate?.trend).toEqual([10, 0, 0, 0]);
  });

  it("a range is filled from its start once capture is known to predate it", async () => {
    await point("staging", hoursBack(30), 50, 0); // outside 24h, inside 7d
    await point("staging", hoursBack(1), 300, 0);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const day = ok(d.usage)["24h"][0].requests;
    expect(day?.trend).toHaveLength(24);
    expect(day?.trend.slice(-2)).toEqual([0, 300]);
    expect(day?.value).toBe("300");
    // 7d: 24-hour buckets ending at the last complete hour; the first captured
    // point sits in the second-to-last bucket.
    const week = ok(d.usage)["7d"][0].requests;
    expect(week?.trend).toEqual([50, 300]);
    expect(week?.value).toBe("350");
  });

  it("an environment with points in 7d but none in 24h is null for 24h only", async () => {
    await point("production", hoursBack(40), 2_500_000, 100);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const usage = ok(d.usage);
    expect(usage["24h"][1]).toMatchObject({ name: "production", requests: null, errorRate: null });
    expect(usage["7d"][1].requests).toMatchObject({ value: "2.50M" });
    expect(usage["7d"][1].errorRate).toMatchObject({ value: "0.00%", tone: "good" });
    // The Cloudflare panel is gated on the WIDEST range; a narrower one may be empty.
    const cf = ok(d.cloudflare);
    expect(cf["24h"]).toEqual([]);
    expect(cf["7d"].map((r) => r.value)).toEqual(["2.50M", "100"]);
  });

  it("captured hours with zero requests read 0 and a true 0.00%, never a division by zero", async () => {
    await point("staging", hoursBack(1), 0, 0);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "0" });
    expect(staging.errorRate).toMatchObject({ value: "0.00%", tone: "good", trend: [0] });
  });

  it("never reads the current, incomplete hour even if a row for it exists", async () => {
    await point("staging", hoursBack(1), 300, 0);
    await point("staging", hoursBack(0), 9999, 0);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "300", trend: [300] });
  });

  it("rows that all aged out of the 30-day read → empty, not not_connected", async () => {
    await point("staging", hoursBack(31 * 24), 100, 0);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(d.usage.status).toBe("empty");
    expect(d.cloudflare.status).toBe("empty");
  });

  it("no environment configured → not_connected whatever is stored", async () => {
    await point("staging", hoursBack(1), 300, 0);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, []);
    expect(d.usage.status).toBe("not_connected");
    expect(d.cloudflare.status).toBe("not_connected");
  });

  it("active users alone connect the usage section but not the Cloudflare panel", async () => {
    await putMetric(env.DB, { metric: "active_users_24h", env: "staging", part: "", value: 41, at: hoursBack(2) });
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(ok(d.usage)["24h"][0]).toMatchObject({ requests: null, errorRate: null, users: { value: "41" } });
    expect(ok(d.usage)["7d"][0].users).toBeNull();
    expect(d.cloudflare.status).toBe("not_connected");
  });
});
