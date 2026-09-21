/**
 * Task 16 — Cloudflare Workers analytics (source K).
 *
 * `pollCloudflare` writes hourly `cf_requests` / `cf_errors` per frontend Worker
 * for 3 COMPLETE hours, lagged one hour (Task 16b), and records how far each
 * environment has been polled in the `cf_polled` snapshot; `getRepoDashboard`
 * projects the Usage tab's requests / error rate and the Cloudflare panel from
 * ONE read of those rows, zero-filling only as far as a poll has looked.
 * The fetch is stubbed at the Response level; every assertion is on D1 rows or
 * on the projection built from them.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pollCloudflare } from "../src/repo/poll";
import { getSnapshot, putMetric, putSnapshot } from "../src/repo/store";
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
      // 3 COMPLETE hours, LAGGED one: `to` is the current hour's floor minus an
      // hour, so the adaptive dataset has had an hour to settle before the
      // first (and only) write of each bucket.
      expect(sent.variables).toMatchObject({ a: "acct", from: "2026-09-20T08:00:00.000Z", to: "2026-09-20T11:00:00.000Z" });
      // Cloudflare's schema spells the scalar `string`, lowercase — `String!` is rejected.
      expect(sent.query).toContain("$a: string!");
      expect(sent.query).toContain("$s: string!");
      expect(sent.query).toContain("$from: Time!");
      expect(sent.query).not.toContain("String");
      expect(sent.query).toContain("workersInvocationsAdaptive");
      return json(cfBody([hourRow("2026-09-20T09:00:00Z", 500, 12), hourRow("2026-09-20T10:00:00Z", 640, 3)]));
    }) as typeof fetch;
    await pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl);
    expect(seen).toEqual(["frontend-staging", "frontend"]);
    expect((await stored()).filter((r) => r.env === "staging")).toEqual([
      { metric: "cf_errors", env: "staging", part: "frontend", value: 12, at: "2026-09-20T09:00:00.000Z" },
      { metric: "cf_errors", env: "staging", part: "frontend", value: 3, at: "2026-09-20T10:00:00.000Z" },
      { metric: "cf_requests", env: "staging", part: "frontend", value: 500, at: "2026-09-20T09:00:00.000Z" },
      { metric: "cf_requests", env: "staging", part: "frontend", value: 640, at: "2026-09-20T10:00:00.000Z" },
    ]);
    expect((await stored()).filter((r) => r.env === "production")).toHaveLength(4);
  });

  it("the overlap is a no-op: a second poll of the same hours writes nothing new, and the first value stands", async () => {
    const at = "2026-09-20T10:00:00Z";
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
        ? json({ errors: [{ message: "unknown field" }], ...cfBody([hourRow("2026-09-20T10:00:00Z", 1, 1)]) })
        : json(cfBody([hourRow("2026-09-20T10:00:00Z", 640, 3)]));
    }) as typeof fetch;
    await expect(pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl)).resolves.toBeUndefined();
    expect((await stored()).map((r) => [r.env, r.metric, r.value])).toEqual([["production", "cf_errors", 3], ["production", "cf_requests", 640]]);
  });

  // `datetime_leq: to` is INCLUSIVE, so the bucket AT `to` can come back. It is
  // the hour that closed seconds ago — complete by the clock, but the adaptive
  // dataset may still be short of it, and INSERT OR IGNORE would make that
  // short count PERMANENT. It is stored an hour later instead.
  it("skips the bucket AT `to` — the hour that only just closed is never stored", async () => {
    const fetchImpl = (async () => json(cfBody([
      hourRow("2026-09-20T10:00:00Z", 640, 3),
      hourRow("2026-09-20T11:00:00Z", 7, 0),  // AT `to`: closed at 12:00, five minutes before NOW
      hourRow("2026-09-20T12:00:00Z", 7, 0),  // the hour in progress at NOW (12:05)
      hourRow("2026-09-20T13:00:00Z", 1, 0),  // a clock ahead of ours
    ]))) as typeof fetch;
    await pollCloudflare(env.DB, CF, [ENVS[0]], NOW, fetchImpl);
    expect((await stored()).map((r) => r.at)).toEqual(["2026-09-20T10:00:00.000Z", "2026-09-20T10:00:00.000Z"]);
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
    // Nothing was looked at — no account matched — so nothing is "polled through".
    expect(await polled()).toBeNull();
  });
});

// ── the `cf_polled` marker (Task 16b) ────────────────────────────────────────
// Cloudflare returns NO row for an hour without invocations, so "no row" only
// means "zero" for hours a poll is known to have looked at. Each environment's
// successful poll records the (exclusive) bound it looked through.
const polled = async () => (await getSnapshot<Record<string, string>>(env.DB, "cf_polled"))?.data ?? null;
const TO = "2026-09-20T11:00:00.000Z";           // pollCloudflare's `to` at NOW
const EARLIER = NOW - 2 * HOUR;                   // a poll two hours before …
const EARLIER_TO = "2026-09-20T09:00:00.000Z";    // … looked through here
const quiet = (async () => json(cfBody([]))) as typeof fetch;
const workerOf = (init?: RequestInit) => (JSON.parse(String(init?.body)) as { variables: { s: string } }).variables.s;

describe("pollCloudflare — the polled-through marker", () => {
  it("a successful poll records every environment as polled through `to`, in ONE snapshot row", async () => {
    await pollCloudflare(env.DB, CF, ENVS, NOW, (async () => json(cfBody([hourRow("2026-09-20T10:00:00Z", 640, 3)]))) as typeof fetch);
    expect(await polled()).toEqual({ staging: TO, production: TO });
    expect(await all(env.DB, `SELECT kind FROM repo_snapshots`)).toEqual([{ kind: "cf_polled" }]);
  });

  // The whole point of the marker: a poll that LOOKED and found nothing is what
  // entitles the projection to draw a zero.
  it("a successful poll that returned zero rows still advances the bound", async () => {
    await pollCloudflare(env.DB, CF, ENVS, NOW, quiet);
    expect(await stored()).toEqual([]);
    expect(await polled()).toEqual({ staging: TO, production: TO });
  });

  it.each([
    ["a 403", () => json({ errors: [{ message: "unauthorized" }] }, 403)],
    ["a 200 carrying `errors`", () => json({ errors: [{ message: "unknown field" }], ...cfBody([]) })],
    ["a body with no account", () => json({ data: { viewer: { accounts: [] } } })],
  ])("%s keeps that environment's previous bound while the other environment's advances", async (_name, failure) => {
    await pollCloudflare(env.DB, CF, ENVS, EARLIER, quiet);
    expect(await polled()).toEqual({ staging: EARLIER_TO, production: EARLIER_TO });
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      workerOf(init) === "frontend-staging" ? failure() : json(cfBody([]))) as typeof fetch;
    await pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl);
    expect(await polled()).toEqual({ staging: EARLIER_TO, production: TO });
  });

  it("an environment that has never succeeded has no bound at all", async () => {
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (workerOf(init) === "frontend-staging") throw new Error("connect timeout");
      return json(cfBody([]));
    }) as typeof fetch;
    await pollCloudflare(env.DB, CF, ENVS, NOW, fetchImpl);
    expect(await polled()).toEqual({ production: TO });
  });

  it("never moves a bound backwards: a poll with an earlier clock leaves it where it was", async () => {
    await pollCloudflare(env.DB, CF, ENVS, NOW, quiet);
    const before = await getSnapshot(env.DB, "cf_polled");
    await pollCloudflare(env.DB, CF, ENVS, EARLIER, quiet);
    expect(await getSnapshot(env.DB, "cf_polled")).toEqual(before); // same bounds, and not even rewritten
  });

  // Compared as parsed instants: a bound stored without milliseconds is the SAME
  // instant as `to`, not an older string.
  it("compares bounds as instants, and replaces one it cannot parse", async () => {
    await putSnapshot(env.DB, "cf_polled", { staging: "2026-09-20T13:00:00Z", production: "not a date" });
    await pollCloudflare(env.DB, CF, ENVS, NOW, quiet);
    expect(await polled()).toEqual({ staging: "2026-09-20T13:00:00Z", production: TO });
  });

  it("writes nothing when every environment fails", async () => {
    const down = (async () => json({}, 500)) as typeof fetch;
    await pollCloudflare(env.DB, CF, ENVS, NOW, down);
    expect(await polled()).toBeNull();
    // … and leaves an existing marker exactly as it was.
    await pollCloudflare(env.DB, CF, ENVS, EARLIER, quiet);
    const before = await getSnapshot(env.DB, "cf_polled");
    await pollCloudflare(env.DB, CF, ENVS, NOW, down);
    expect(await getSnapshot(env.DB, "cf_polled")).toEqual(before);
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

  // ── Task 16b: zeros are drawn only as far as a poll is known to have looked ──
  // `cf_polled` is `{ [envKey]: <exclusive bound> }`: polled through 11:00 means
  // the 10:00 bucket (hoursBack(2)) is the last one known.
  const markPolled = (bounds: Record<string, string>) => putSnapshot(env.DB, "cf_polled", bounds);

  it("zero-fills past the last real point up to the polled bound — and no further", async () => {
    await point("staging", hoursBack(5), 100, 10);
    await point("staging", hoursBack(3), 300, 0);
    await point("production", hoursBack(5), 70, 0);
    await markPolled({ staging: hoursBack(1) }); // staging only: a bound never leaks to another environment
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const [staging, production] = ok(d.usage)["24h"];
    // 07:00, 08:00, 09:00, 10:00. The 11:00 bucket (hoursBack(1)) is NOT drawn: no poll has looked at it yet.
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300, 0], tone: "neutral" });
    expect(staging.errorRate).toEqual({ value: "2.50%", trend: [10, 0, 0, 0], tone: "warn" });
    expect(production.requests).toEqual({ value: "70", trend: [70], tone: "neutral" });
  });

  it("with NO marker the trend ends at the last real point", async () => {
    await point("staging", hoursBack(5), 100, 10);
    await point("staging", hoursBack(3), 300, 0);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300], tone: "neutral" });
    expect(staging.errorRate?.trend).toEqual([10, 0, 0]);
  });

  // The poll died three days ago: nothing after its bound is known to be zero.
  it("a marker days old draws no zeros after it", async () => {
    await point("staging", hoursBack(100), 50, 0);
    await markPolled({ staging: hoursBack(72) });
    const usage = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).usage);
    // 7d = seven 24h buckets ending at 12:00. The point sits in bucket 2; the last
    // polled hour (hoursBack(73)) in bucket 3. Buckets 4–6 are unknown, not zero.
    expect(usage["7d"][0].requests).toEqual({ value: "50", trend: [50, 0], tone: "neutral" });
    // 24h: capture predates the range, but no poll has looked inside it.
    expect(usage["24h"][0]).toMatchObject({ requests: null, errorRate: null });
  });

  it("a marker older than the last real point never truncates real points", async () => {
    await point("staging", hoursBack(5), 100, 0);
    await point("staging", hoursBack(3), 300, 0);
    await markPolled({ staging: hoursBack(10) });
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300], tone: "neutral" });
  });

  it("a range with no real point, but polled and captured before it, reads a true 0 — and no error rate", async () => {
    await point("staging", hoursBack(30), 50, 5); // outside 24h, inside 7d
    await markPolled({ staging: hoursBack(1) });
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const day = ok(d.usage)["24h"][0];
    // 23 buckets, not 24: the range's last hour (11:00) has not been polled yet.
    expect(day.requests).toEqual({ value: "0", trend: new Array(23).fill(0), tone: "neutral" });
    expect(day.errorRate).toBeNull(); // 0 of 0 is not a rate
    expect(ok(d.cloudflare)["24h"]).toEqual([
      { env: "staging", label: "Workers requests", value: "0" },
      { env: "staging", label: "Workers errors", value: "0" },
    ]);
    // 7d: the point sits in bucket 5, the last polled hour in bucket 6.
    expect(ok(d.usage)["7d"][0].requests).toEqual({ value: "50", trend: [50, 0], tone: "neutral" });
    expect(ok(d.usage)["7d"][0].errorRate).toMatchObject({ value: "10.00%", trend: [10, 0] });
  });

  it("a marker alone — polled, but nothing ever captured — connects nothing", async () => {
    await markPolled({ staging: hoursBack(1), production: hoursBack(1) });
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(d.usage.status).toBe("not_connected");
    expect(d.cloudflare.status).toBe("not_connected");
  });

  it("a bound ahead of the clock fills only to the last complete hour; an unparseable one is no bound", async () => {
    await point("staging", hoursBack(3), 300, 0);
    await point("production", hoursBack(3), 300, 0);
    await markPolled({ staging: hoursBack(-5), production: "not a date" });
    const [staging, production] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests?.trend).toEqual([300, 0, 0]);
    expect(production.requests?.trend).toEqual([300]);
  });

  it("active users alone connect the usage section but not the Cloudflare panel", async () => {
    await putMetric(env.DB, { metric: "active_users_24h", env: "staging", part: "", value: 41, at: hoursBack(2) });
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(ok(d.usage)["24h"][0]).toMatchObject({ requests: null, errorRate: null, users: { value: "41" } });
    expect(ok(d.usage)["7d"][0].users).toBeNull();
    expect(d.cloudflare.status).toBe("not_connected");
  });
});
