/**
 * The Repo dashboard screens (web/src/repo.ts) — pure render tests.
 *
 * What matters here: each section renders in the state the Worker gave it
 * (`ok` / `empty` / `not_connected`), the whole screen has loading and error
 * forms, nothing captured is trusted as markup, and the sample set is labelled.
 */
import { describe, it, expect } from "vitest";
import { repoView, repoControls, repoCrumb, repoUpdatedLabel, sparkPoints, ago, type RepoProps } from "../web/src/repo";
import { repoSample } from "../web/src/repo-sample";
import { render, initialState } from "../web/src/render";
import { REPO_TABS, type RepoDashboard, type RepoPerson, type RepoProductEnv, type UsagePollResult } from "@shared/repo";

const NC = { status: "not_connected" } as const;
const EMPTY = { status: "empty" } as const;

/** What the Worker returns today for an empty store. */
function live(over: Partial<RepoDashboard> = {}): RepoDashboard {
  return {
    repo: "SaplingLearn/sapling", generatedAt: new Date().toISOString(), degraded: false,
    environments: NC, drift: NC, health: NC, branches: NC, deploys: NC, ciFailures: NC, coverage: NC, bundle: NC,
    usage: NC, cloudflare: NC, hosting: NC, product: NC, todos: NC,
    stats: EMPTY, codeStats: EMPTY, bars: EMPTY, prs: EMPTY, activity: EMPTY, sprint: EMPTY, contributors: EMPTY, labels: EMPTY,
    ...over,
  };
}

function props(over: Partial<RepoProps> = {}): RepoProps {
  return { tab: "overview", range: "7d", driftOpen: false, repo: { status: "ok", data: live() }, fetchedAt: Date.now(), sample: false, admin: false, poll: null, ...over };
}

describe("repoView — section states", () => {
  it("renders every tab from the sample set without a stray undefined/NaN", () => {
    const data = repoSample();
    for (const [tab] of REPO_TABS) {
      const html = repoView(props({ tab, repo: { status: "ok", data }, sample: true }));
      expect(html, tab).not.toMatch(/undefined|NaN|\[object/);
      expect(html, tab).toContain("sample data");
    }
  });

  // P5-12: the banner says EVERY section shows placeholder values — so none may
  // sit unconnected (telling a previewer to set a secret), and two numbers the
  // real projection derives from one sum may not disagree.
  it("the sample set has no unconnected section, and its Cloudflare panel agrees with its Requests metric", () => {
    const data = repoSample();
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "status" in value) expect((value as { status: string }).status, key).toBe("ok");
    }
    const okOf = <T>(s: { status: string; data?: T }) => (s as { data: T }).data;
    expect(okOf(data.hosting).map((h) => h.env)).toEqual(["staging", "production"]);
    for (const range of ["24h", "7d", "30d"] as const) {
      for (const e of okOf(data.usage)[range]) {
        const row = okOf(data.cloudflare)[range].find((r) => r.env === e.name && r.label === "Workers requests");
        expect(row?.value, `${range} ${e.name}`).toBe(e.requests?.value);
      }
    }
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data }, sample: true }));
    expect(html).not.toContain("Source not connected");
    expect(html).not.toContain("RAILWAY_TOKEN");
  });

  it("shows 'Source not connected' for a section nothing has been captured for, with no dead button", () => {
    const html = repoView(props({ tab: "usage" }));
    expect((html.match(/Source not connected/g) ?? []).length).toBe(4); // usage, Cloudflare, hosting, product
    expect(html).not.toContain("Connect Cloudflare");
    expect(html).toContain('data-act="repoSampleOn"');
  });

  // Every section has a capture path now, so an unconnected one names what that
  // path is still WAITING on (a setting/secret by name, a webhook event, the
  // repo's CI, Sync GitHub) — never that no path exists, never a connect flow.
  it("a not-connected section says what its capture is waiting on, in the owner's terms", () => {
    const tab = (t: RepoProps["tab"]) => repoView(props({ tab: t }));
    const overview = tab("overview"), code = tab("code"), ci = tab("ci"), usage = tab("usage"), planning = tab("planning");
    expect(overview).toContain("Cards appear once REPO_ENVIRONMENTS lists an environment");
    expect(overview).toContain("The repo cron pings each environment in REPO_ENVIRONMENTS every 10 minutes");
    expect(code).toContain("No branch snapshot yet. One is taken when an admin runs Sync GitHub and by the 6-hourly GitHub reconcile — both need GITHUB_SERVICE_TOKEN.");
    expect(ci).toContain("Deploys arrive when the GitHub webhook delivers deployment_status and check_run events, or when an admin runs Sync GitHub");
    expect(ci).toContain("Runs arrive when the GitHub webhook delivers workflow_run events, or when an admin runs Sync GitHub.");
    // P5-8: no branch NAME — the screen does not know which branch the first environment deploys from.
    expect(ci).toContain("posts a canopy/coverage commit status on a push to the default environment branch and the GitHub webhook delivers status events.");
    expect(ci).toContain("posts a canopy/bundle-kb commit status on a push to the default environment branch and the GitHub webhook delivers status events.");
    expect(usage).toContain("hourly Cloudflare analytics poll (CF_ANALYTICS_TOKEN and CF_ANALYTICS_ACCOUNT_ID)");
    expect(usage).toContain("metrics endpoint (SAPLING_METRICS_TOKEN)");
    expect(usage).toContain("RAILWAY_TOKEN_&lt;ENVIRONMENT&gt; secret is set and REPO_ENVIRONMENTS carries its railwayEnvironmentId and railwayServiceId.");
    expect(planning).toContain("posts a canopy/todo commit status on a push to the default environment branch and the GitHub webhook delivers status events.");
    expect([ci, planning].join("\n")).not.toContain("push to main");

    const all = [overview, code, ci, usage, planning].join("\n");
    for (const stale of ["no capture path", "aren&#39;t captured", "nothing pings", "nothing scans", "not refs", "is ingested yet", "for this repo yet"]) {
      expect(all, stale).not.toContain(stale);
    }
    // The page-level legend says the same thing: nothing captured YET, not "no path".
    expect(overview).toContain("have had nothing captured yet — each says what it is waiting on.");
  });

  // P5-9: the Worker emits `bars` as ok / empty only, so it carries no
  // not-connected copy of its own. The type still allows the state; if it ever
  // arrived it gets the generic line, never a sentence about a missing source.
  it("bars has no bespoke not-connected copy — the generic line covers a state the Worker never sends", () => {
    const html = repoView(props({ tab: "code", repo: { status: "ok", data: live({ bars: NC }) } }));
    expect(html).not.toContain("Commit activity isn&#39;t connected.");
    expect(html).not.toContain("Commit activity isn't connected.");
    expect(html).toContain("Nothing has been captured for this section yet.");
    expect(html).not.toMatch(/undefined/);
  });

  it("an empty activity chart claims neither commits nor merges", () => {
    expect(repoView(props({ tab: "code" }))).toContain("No commits or merges in the last 14 days.");
  });

  it("shows 'Nothing here yet' for a connected section with no rows", () => {
    const html = repoView(props({ tab: "planning" }));
    expect(html).toContain("No sprint is active");
    expect(html).toContain("No pushes, merges or reviews this week.");
  });

  it("first load is skeletons; a failed first load is an error with Retry", () => {
    const loading = repoView(props({ repo: { status: "loading", data: null } }));
    expect(loading).toContain("repo-shimmer");
    expect(loading).not.toContain("Source not connected");

    const failed = repoView(props({ repo: { status: "error", data: null } }));
    expect(failed).toContain("Couldn't load this section");
    expect(failed).toContain('data-act="repoRefresh"');
  });

  it("a refresh keeps the last payload on screen", () => {
    const html = repoView(props({ tab: "code", repo: { status: "loading", data: repoSample() }, sample: true }));
    expect(html).not.toContain("repo-shimmer");
    expect(html).toContain("Batch D1 reads in usage rollup");
  });

  it("offers the sample preview only while something on the tab is unconnected", () => {
    const allLive = { ...repoSample(), sample: undefined, hosting: { status: "ok", data: [] } } as RepoDashboard;
    expect(repoView(props({ tab: "usage", repo: { status: "ok", data: allLive } }))).not.toContain("repoSampleOn");
    expect(repoView(props({ tab: "usage", sample: true, repo: { status: "ok", data: repoSample() } }))).toContain('data-act="repoSampleOff"');
  });
});

describe("repoView — live content", () => {
  it("escapes captured titles and refuses a non-http URL", () => {
    const data = live({
      prs: { status: "ok", data: [{ number: 7, title: `<img src=x onerror=1>`, url: "javascript:alert(1)", author: { login: "x", handle: null, name: null, color: null }, branch: "→ main", state: "merged", checks: null, at: new Date().toISOString() }] },
    });
    const html = repoView(props({ tab: "code", repo: { status: "ok", data } }));
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("MERGED");
  });

  // Task 12: the Branches block was built ahead of the capture landing — this
  // pins that it renders the snapshot's row shape (name/at/ahead/behind/stale)
  // and escapes a captured branch name the same way the PR list does.
  it("renders the branches snapshot, escaping a captured name and flagging STALE", () => {
    const data = live({
      branches: {
        status: "ok",
        data: {
          active: 1, stale: 1, head: "develop",
          rows: [
            { name: `feature/<script>alert(1)</script>`, at: new Date().toISOString(), ahead: 4, behind: 0, stale: false },
            { name: "spike/edge-cache", at: "2026-09-04T00:00:00Z", ahead: 7, behind: 31, stale: true },
          ],
        },
      },
    });
    const html = repoView(props({ tab: "code", repo: { status: "ok", data } }));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    // P5-8: the comparison branch is the snapshot's own `head`, never an assumed `main`.
    expect(html).toContain("+4 / −0 vs develop");
    expect(html).toContain("+7 / −31 vs develop");
    expect(html).not.toContain("vs main");
    expect(html).toContain("STALE");
    expect(html).toContain("1 active · 1 stale");
  });

  it("a branches snapshot written before `head` was recorded shows the counts with NO 'vs …' — never a guessed branch; a captured head is escaped", () => {
    const row = { name: "feature/x", at: new Date().toISOString(), ahead: 4, behind: 2, stale: false };
    const old = repoView(props({ tab: "code", repo: { status: "ok", data: live({ branches: { status: "ok", data: { active: 1, stale: 0, rows: [row] } } }) } }));
    expect(old).toContain("+4 / −2<");
    expect(old).not.toMatch(/vs (main|undefined)/);
    const odd = repoView(props({ tab: "code", repo: { status: "ok", data: live({ branches: { status: "ok", data: { active: 1, stale: 0, head: "<b>x</b>", rows: [row] } } }) } }));
    expect(odd).toContain("vs &lt;b&gt;x&lt;/b&gt;");
  });

  it("names the PR-list header from what's actually shown, not the sample flag", () => {
    const prRow = (state: "review" | "merged") => ({
      number: 1, title: "PR", url: "https://github.com/o/r/pull/1",
      author: { login: "x", handle: null, name: null, color: null }, branch: "feat/x", state, checks: null, at: new Date().toISOString(),
    });
    const open = live({ prs: { status: "ok", data: [prRow("review")] } });
    expect(repoView(props({ tab: "code", repo: { status: "ok", data: open } }))).toContain("Pull requests — open &amp; recent");

    const closed = live({ prs: { status: "ok", data: [prRow("merged")] } });
    expect(repoView(props({ tab: "code", repo: { status: "ok", data: closed } }))).toContain("Pull requests — recently closed");
  });

  it("draws one bar per day and scales them to the busiest", () => {
    const days = Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(7 + i).padStart(2, "0")}`, count: i === 13 ? 4 : i === 0 ? 2 : 0 }));
    const data = live({ bars: { status: "ok", data: { title: "Merge activity — last 14 days", note: "6 merged PRs · all branches", days } } });
    const html = repoView(props({ tab: "code", repo: { status: "ok", data } }));
    expect((html.match(/class="repo-bar"/g) ?? []).length).toBe(14);
    expect(html).toContain('height="25.00"');   // the max
    expect(html).toContain('height="12.50"');   // half of it
    expect(html).toContain("Merge activity — last 14 days");
  });

  it("the drift strip is an attribute-driven disclosure", () => {
    const data = repoSample();
    expect(repoView(props({ repo: { status: "ok", data } }))).toContain('class="repo-drift" data-open="0"');
    const open = repoView(props({ repo: { status: "ok", data }, driftOpen: true }));
    expect(open).toContain('class="repo-drift" data-open="1"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("12</span> commits ahead");
  });

  it("the usage range picks its own series", () => {
    const data = repoSample();
    expect(repoView(props({ tab: "usage", range: "24h", repo: { status: "ok", data } }))).toContain("12.4K");
    expect(repoView(props({ tab: "usage", range: "30d", repo: { status: "ok", data } }))).toContain("5.1M");
  });

  it("a usage metric with no source says so in place, without blanking its neighbours", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: { value: "12.4K", trend: [1, 2, 3], tone: "neutral" as const }, errorRate: { value: "2.41%", trend: [1, 2], tone: "warn" as const }, users: null, seen: { requests: true, users: false } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } } });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect(html).toContain("12.4K");
    expect(html).toContain("Active users");
    expect(html).toContain("not connected");
  });

  it("a usage env with every metric unconnected still renders its name, host, and three not-connected rows", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: null, seen: { requests: false, users: false } };
    const data = live({
      usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } },
      cloudflare: EMPTY, hosting: EMPTY, product: EMPTY,
    });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect(html).toContain("staging");
    expect(html).toContain("staging.saplinglearn.com");
    expect((html.match(/not connected/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/undefined|NaN/);
  });

  // Task 16b: `errorRate: null` beside LIVE requests is not "not connected" —
  // the source is connected, there were simply no requests to take a rate of.
  it("an error rate with nothing to take a rate of reads a quiet dash, not 'not connected'", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: { value: "0", trend: [0, 0, 0], tone: "neutral" as const }, errorRate: null, users: { value: "4", trend: [3, 4], tone: "neutral" as const }, seen: { requests: true, users: true } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    const errRow = html.slice(html.indexOf("Error rate"), html.indexOf("Active users"));
    expect(errRow).toContain(">—<");
    expect(errRow).not.toContain("not connected");
    expect(errRow).not.toContain("<svg"); // no sparkline for a rate that does not exist
    expect(html).not.toContain("not connected"); // nothing on this card is unconnected
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("an error rate whose requests are ALSO unconnected still says 'not connected'", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: { value: "4", trend: [3, 4], tone: "neutral" as const }, seen: { requests: false, users: true } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    const errRow = html.slice(html.indexOf("Error rate"), html.indexOf("Active users"));
    expect(errRow).toContain("not connected");
    expect(errRow).not.toContain(">—<");
    expect((html.match(/not connected/g) ?? []).length).toBe(2);
  });

  // P5-2: a null metric whose source HAS reported (inside the 30-day read) is
  // connected and quiet — saying "not connected" there was false.
  it("a null metric whose source has been seen reads 'no recent reading', never 'not connected'", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: null, seen: { requests: true, users: true } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect((html.match(/no recent reading/g) ?? []).length).toBe(3); // requests, error rate (follows requests), users
    expect(html).not.toContain("not connected");
    expect(html).not.toMatch(/undefined|NaN|<svg viewBox="0 0 100 26"/);
  });

  it("the two labels sit side by side: requests seen and quiet, users never connected", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: null, seen: { requests: true, users: false } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    const row = (from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to));
    expect(row("Requests", "Error rate")).toContain("no recent reading");
    expect(row("Error rate", "Active users")).toContain("no recent reading");
    const usersRow = html.slice(html.indexOf("Active users"));
    expect(usersRow).toContain("not connected");
    expect(usersRow).not.toContain("no recent reading");
  });

  it("usage empty says the polls have gone quiet — never that nothing was recorded in 30 days", () => {
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ usage: EMPTY }) } }));
    expect(html).toContain("No current usage reading — the hourly polls have gone quiet.");
    expect(html).not.toContain("No usage recorded in the last 30 days.");
  });

  // Task 17: the hosting block's three states.
  it("hosting renders its rows when live, and says the reading is stale — not absent — when empty", () => {
    const rows = [{ env: "staging", cpu: "0.12 vCPU", memory: "410 MB" }, { env: "production", cpu: "—", memory: "2048 MB" }];
    const okHtml = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ hosting: { status: "ok", data: rows } }) } }));
    expect(okHtml).toContain("Hosting — Railway backend");
    expect(okHtml).toContain("0.12 vCPU");
    expect(okHtml).toContain("2048 MB");
    const stale = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ hosting: EMPTY }) } }));
    expect(stale).toContain("No fresh hosting reading — the last Railway sample is over 3 hours old.");
    const never = repoView(props({ tab: "usage", repo: { status: "ok", data: live() } }));
    expect(never).not.toContain("No fresh hosting reading");
  });

  // Task 16: the Cloudflare panel is `ok` once the WIDEST range has rows, so a
  // narrower range can legitimately be empty — say so, never a blank panel.
  it("a Cloudflare range with no rows says so instead of rendering a blank panel", () => {
    const rows = [{ env: "staging", label: "Workers requests", value: "2.50M" }];
    const data = live({ cloudflare: { status: "ok", data: { "24h": [], "7d": rows, "30d": rows } } });
    const quiet = repoView(props({ tab: "usage", range: "24h", repo: { status: "ok", data } }));
    // Not "No requests": that claims zero traffic for a range a poll may never have covered.
    expect(quiet).toContain("Nothing recorded in this range.");
    expect(quiet).not.toContain("No requests in this range.");
    const week = repoView(props({ tab: "usage", range: "7d", repo: { status: "ok", data } }));
    expect(week).toContain("2.50M");
    expect(week).not.toContain("Nothing recorded in this range.");
  });

  it("M11: renders a null reviews count as an em dash, excluded from the bar width", () => {
    const person = (login: string): RepoPerson => ({ login, handle: login, name: null, color: null });
    const data = live({
      contributors: {
        status: "ok",
        data: [
          { person: person("a"), pushes: 4, merged: 2, reviews: null },
          { person: person("b"), pushes: 1, merged: 0, reviews: null },
        ],
      },
    });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain("4 · 2 · —");
    expect(html).toContain("1 · 0 · —");
    // max = 4 + 2 + 0 (reviews excluded, not counted as 0-contribution-but-present) → row "a" fills 100%.
    expect(html).toContain("width:100%");
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("an environment card shows a line per deployable and says when one has no capture", () => {
    const data = live({ environments: { status: "ok", data: [{ key: "staging", name: "staging", note: "main", tone: "good", pill: "HEALTHY", ci: "All 8 checks passing", ciTone: "good", url: "https://staging.saplinglearn.com",
      parts: [{ part: "backend", host: "Railway", sha: "abc1234", deployedAt: new Date().toISOString(), deployedBy: "AndresL230", result: "ok" }, { part: "frontend", host: "Cloudflare", sha: null, deployedAt: null, deployedBy: null, result: null }] }] } });
    const html = repoView(props({ repo: { status: "ok", data } }));
    expect(html).toContain("Backend");
    expect(html).toContain("by AndresL230 · Railway");
    expect(html).toContain("No Cloudflare deploy captured yet");
    expect(html).not.toMatch(/undefined|NaN/);
  });

  // F3: `rate: null` = run capture has not covered a whole week yet. The header
  // percentage and the sparkline both describe seven days, so neither may be
  // drawn — but the failures themselves are facts and stay listed.
  it("a CI block with no 7-day rate yet shows no percentage, no sparkline, and says why", () => {
    const data = live({ ciFailures: { status: "ok", data: { rate: null, trend: [], rows: [
      { workflow: "e2e (browser lane)", branch: "main", job: "e2e · run suite", at: new Date().toISOString(), url: "https://github.com/o/r/actions/runs/3" },
    ] } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain("A 7-day rate appears after a week of captured runs.");
    expect(html).not.toMatch(/>\d+\.\d%</); // no headline percentage rendered as text
    expect(html).not.toContain("repo-spark");
    expect(html).toContain("e2e · run suite");
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("shows the rate and the sparkline once a week of runs is captured", () => {
    const data = live({ ciFailures: { status: "ok", data: { rate: 6.7, trend: [4, 9, 6, 3, 11, 8, 5], rows: [] } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain("6.7%");
    expect(html).toContain("repo-spark");
    expect(html).not.toContain("A 7-day rate appears");
  });

  it("labels each deploy strip with its environment AND its half", () => {
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data: repoSample() }, sample: true }));
    for (const label of ["staging · api", "staging · web", "production · api", "production · web"]) expect(html).toContain(label);
  });

  // Task 14, controller ruling M2: a delta ("" for RepoTrend, null for
  // RepoTodos) means the window can't support a trend claim — the screen
  // shows the value/count and sparkline but renders no delta text and, for
  // TODOs, no "since" text either. No stray leading space where the delta
  // used to sit.
  it("a coverage trend with no delta claim (delta: \"\") shows the value and note with no delta text or stray space", () => {
    const data = live({ coverage: { status: "ok", data: { value: "80.1%", trend: [80.1], delta: "", tone: "neutral", note: "over 30 days" } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain("80.1%");
    expect(html).toContain("over 30 days");
    expect(html).not.toContain("</span> over 30 days"); // no empty delta span left behind
    expect(html).not.toMatch(/>\s+over 30 days/); // no leading space where the delta span used to sit
    // M11: a single-point trend can't draw a line — no sparkline element at all.
    expect(html).not.toContain("repo-spark");
  });

  it("still shows the delta text once the window supports a claim", () => {
    const data = live({ coverage: { status: "ok", data: { value: "78.4%", trend: [77.2, 78.4], delta: "+1.2", tone: "good", note: "over 30 days" } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain('color:var(--green)">+1.2</span> over 30 days');
    // Two points DO draw a line.
    expect(html).toContain("repo-spark");
  });

  it("a TODO count with no delta claim (delta: null) shows the count with no delta and no since text", () => {
    const data = live({ todos: { status: "ok", data: { count: 50, delta: null, since: "", trend: [50] } } });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain("50");
    expect(html).not.toContain("since");
    expect(html).not.toMatch(/undefined|NaN/);
    // M11: a single-point trend can't draw a line — no sparkline element at all.
    expect(html).not.toContain("repo-spark");
  });

  it("still shows delta and since text once the window supports a claim", () => {
    const data = live({ todos: { status: "ok", data: { count: 43, delta: -18, since: "Aug 1", trend: [61, 43] } } });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain("−18");
    expect(html).toContain("since Aug 1");
    expect(html).toContain("repo-spark");
    // P5-8: the footnote names no branch either.
    expect(html).toContain("counted by CI on each push to the default environment branch");
    expect(html).not.toContain("push to main");
  });

  it("links the current sprint to its screen", () => {
    const data = live({ sprint: { status: "ok", data: { id: 3, label: "Notifications GA", due: "2026-10-02", closed: 21, total: 34, pct: 62 } } });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain('data-act="openSprint" data-arg="3"');
    expect(html).toContain("DUE OCT 2");
    expect(html).toContain("21 closed · 13 open");
    expect(html).toContain("width:62%");
  });
});

describe("repo header chrome", () => {
  it("names the tab and the repo in the breadcrumb", () => {
    const html = repoCrumb(props({ tab: "ci" }));
    expect(html).toContain("CI &amp; Deploys");
    expect(html).toContain("SaplingLearn/sapling");
  });

  it("shows environment pills only when environments are connected", () => {
    expect(repoControls(props())).not.toContain("staging");
    const withEnvs = repoControls(props({ repo: { status: "ok", data: repoSample() } }));
    expect(withEnvs).toContain("staging — degraded");
    expect(withEnvs).toContain("production — healthy");
  });

  it("labels freshness, and says so while a request is out", () => {
    const now = Date.now();
    expect(repoUpdatedLabel({ repo: { status: "ok", data: live() }, fetchedAt: now }, now)).toBe("updated just now");
    expect(repoUpdatedLabel({ repo: { status: "ok", data: live() }, fetchedAt: now - 4 * 60_000 }, now)).toBe("updated 4m ago");
    expect(repoUpdatedLabel({ repo: { status: "loading", data: live() }, fetchedAt: now }, now)).toBe("refreshing…");
    expect(repoUpdatedLabel({ repo: { status: "loading", data: null }, fetchedAt: null }, now)).toBe("loading…");
  });

  it("render() puts the Repo screen in the shell with its title and active nav row", () => {
    const s = { ...initialState(), view: "app" as const, screen: "repo" as const, repoTab: "code" as const, repo: { status: "ok" as const, data: live() } };
    const html = render(s);
    expect(html).toContain(">Repo</h1>");
    expect(html).toContain('class="cnpy-navrow n-repo is-active"');
    expect(html).toContain('data-screen-label="Code"');
  });
});

// ── "Poll now" (admin-only, Usage tab) ───────────────────────────────────────
// ── product metrics (Sapling contract v2) ────────────────────────────────────
describe("repoView — product metrics", () => {
  const all3 = (v: string | null) => ({ "24h": v, "7d": v, "30d": v });
  const staging: RepoProductEnv = {
    name: "staging",
    groups: [
      { id: "growth", title: "Growth", metrics: [
        { key: "signups", label: "Signups", values: { "24h": "3", "7d": "21", "30d": "96" }, raw: { "24h": 3, "7d": 21, "30d": 96 }, trend: [2, 4, 3, 5] },
        { key: "approvals", label: "Approvals", values: all3(null), raw: { "24h": null, "7d": null, "30d": null }, trend: [1] },
      ] },
      { id: "ai", title: "AI spend", metrics: [
        { key: "llm_tokens", label: "LLM tokens", values: { "24h": "41.0K", "7d": "1.23M", "30d": "4.80M" }, raw: { "24h": 41_000, "7d": 1_234_567, "30d": 4_800_000 }, trend: [] },
        { key: "llm_cost_cents", label: "LLM cost", values: { "24h": "$4.12", "7d": "$29.61", "30d": "$118.30" }, raw: { "24h": 412, "7d": 2961, "30d": 11830 }, trend: [300, 412], note: "lower bound — unpriced models are not counted" },
      ] },
    ],
    totals: [
      { key: "users", label: "Users", value: "1.2K", raw: 1204, trend: [1190, 1198, 1204] },
      { key: "rooms", label: "Rooms", value: null, raw: null, trend: [5, 5, 6] },
    ],
  };
  const production: RepoProductEnv = { name: "production", groups: [], totals: [] };
  const view = (over: Partial<RepoProps> = {}, data: RepoProductEnv[] = [staging, production]) =>
    repoView(props({ tab: "usage", repo: { status: "ok", data: live({ product: { status: "ok", data } }) }, ...over }));
  /** The markup of one labelled row: from its label to the end of its grid row. */
  const rowOf = (html: string, label: string) => { const i = html.indexOf(`>${label}<`); expect(i, label).toBeGreaterThan(-1); return html.slice(i, html.indexOf("</div>", i)); };

  it("one titled block per environment, groups as labelled blocks, totals under Right now", () => {
    const html = view();
    expect(html).toContain("Product — staging");
    expect(html).toContain("Product — production");
    for (const title of ["Growth", "AI spend", "Right now"]) expect(html).toContain(`>${title}<`);
    expect(html).not.toMatch(/undefined|NaN|\[object/);
    // Groups the environment did not report are not drawn as empty boxes.
    expect(html).not.toContain(">Community<");
  });

  it("the range selector drives counts — and never totals", () => {
    const at = (range: "24h" | "7d" | "30d") => view({ range });
    expect(rowOf(at("24h"), "Signups")).toContain(">3<");
    expect(rowOf(at("7d"), "Signups")).toContain(">21<");
    expect(rowOf(at("30d"), "Signups")).toContain(">96<");
    expect(rowOf(at("30d"), "LLM cost")).toContain("$118.30");
    for (const range of ["24h", "7d", "30d"] as const) expect(rowOf(at(range), "Users")).toContain(">1.2K<");
  });

  it("the exact integer behind a compacted figure is its title", () => {
    expect(rowOf(view({ range: "7d" }), "LLM tokens")).toContain('title="1,234,567"');
  });

  it("a null figure reads a quiet 'no recent reading' in place — the row and its neighbours stay", () => {
    const html = view();
    expect(rowOf(html, "Approvals")).toContain("no recent reading");
    expect(rowOf(html, "Rooms")).toContain("no recent reading");
    expect(rowOf(html, "Signups")).not.toContain("no recent reading");
    // A stale figure's old trend is not drawn beside "no recent reading": the line would read as current.
    expect(rowOf(html, "Rooms")).not.toContain("<polyline");
  });

  it("draws a sparkline only from two trend points up", () => {
    const html = view();
    expect(rowOf(html, "Signups")).toContain("<polyline");
    expect(rowOf(html, "Users")).toContain("<polyline");
    expect(rowOf(html, "Approvals")).not.toContain("<polyline");   // one point
    expect(rowOf(html, "LLM tokens")).not.toContain("<polyline");  // none
  });

  it("a metric's note is a footnote under its group, once", () => {
    const html = view();
    expect(html.split("lower bound — unpriced models are not counted").length - 1).toBe(1);
    expect(html.indexOf("lower bound")).toBeGreaterThan(html.indexOf(">LLM cost<"));
  });

  it("an environment that reported nothing says so, inside its own block", () => {
    const html = view();
    const prod = html.slice(html.indexOf("Product — production"));
    expect(prod).toContain("This environment has reported no product metrics.");
    expect(html.slice(0, html.indexOf("Product — production"))).not.toContain("has reported no product metrics");
  });

  it("labels, keys, notes and environment names are another service's text — all escaped", () => {
    const hostile = `<img src=x onerror=1>`;
    const html = view({}, [{
      name: hostile,
      groups: [{ id: "other", title: hostile, metrics: [{ key: hostile, label: hostile, values: all3(hostile), raw: { "24h": 1, "7d": 1, "30d": 1 }, trend: [], note: hostile }] }],
      totals: [{ key: hostile, label: hostile, value: hostile, raw: 1, trend: [], note: `"><script>alert(1)</script>` }],
    }]);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("not_connected and empty each say what they are waiting on; loading and error have their forms", () => {
    const nc = repoView(props({ tab: "usage", repo: { status: "ok", data: live() } }));
    expect(nc).toContain("No product metrics reported yet. They appear once the app&#39;s metrics endpoint serves `counts` / `totals` and `SAPLING_METRICS_TOKEN` is set.");
    const quiet = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ product: EMPTY }) } }));
    expect(quiet).toContain("No current product reading — the hourly poll of the app&#39;s metrics endpoint has gone quiet.");
    expect(quiet).not.toContain("No product metrics reported yet");
    for (const html of [nc, quiet]) expect(html).toContain(">Product<");
    expect(repoView(props({ tab: "usage", repo: { status: "loading", data: null } }))).toContain("repo-shimmer");
    expect(repoView(props({ tab: "usage", repo: { status: "error", data: null } }))).toContain("Couldn't load this section");
  });

  it("the not-connected footer counts the product section too", () => {
    const others = { ...repoSample(), sample: undefined } as RepoDashboard;
    expect(repoView(props({ tab: "usage", repo: { status: "ok", data: others } }))).not.toContain("repoSampleOn");
    expect(repoView(props({ tab: "usage", repo: { status: "ok", data: { ...others, product: NC } } }))).toContain("repoSampleOn");
    // …and only on the Usage tab.
    expect(repoView(props({ tab: "code", repo: { status: "ok", data: { ...others, product: NC } } }))).not.toContain("repoSampleOn");
  });

  it("the sample set carries placeholder product metrics for both environments", () => {
    const data = repoSample();
    expect(data.product.status).toBe("ok");
    const envs = (data.product as { data: RepoProductEnv[] }).data;
    expect(envs.map((e) => e.name)).toEqual(["staging", "production"]);
    for (const e of envs) {
      expect(e.groups.map((g) => g.title)).toEqual(["Growth", "Learning activity", "Community", "AI spend", "Reliability"]);
      expect(e.totals.length).toBeGreaterThan(3);
      for (const m of e.groups.flatMap((g) => g.metrics)) {
        expect(m.raw["24h"]! <= m.raw["7d"]! && m.raw["7d"]! <= m.raw["30d"]!, `${e.name} ${m.key}`).toBe(true); // the windows nest, as the contract guarantees
      }
    }
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data }, sample: true }));
    expect(html).toContain("Product — production");
    expect(html).toContain("lower bound — unpriced models are not counted");
  });

  it("entrances use the existing hooks only", () => {
    const html = view();
    const blocks = html.split("Product — ").slice(1);
    expect(blocks).toHaveLength(2);
    expect(html).toMatch(/class="cnpy-rise" style="--i:3;[^"]*"[^>]*>\s*<div[^>]*>\s*<span[^>]*>Product — staging/);
  });
});

describe("repoView — Poll usage now", () => {
  const usage = (over: Partial<RepoProps> = {}) => repoView(props({ tab: "usage", ...over }));
  const done = (result: UsagePollResult) => ({ status: "done" as const, result });
  const NOT: UsagePollResult = { cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured" };

  it("the button is there for an admin — and absent for a non-admin, in sample mode, and off the Usage tab", () => {
    expect(usage({ admin: true })).toContain('data-act="repoPollNow"');
    expect(usage({ admin: true })).toContain(">Poll now</button>");
    expect(usage({ admin: false })).not.toContain("repoPollNow");
    expect(usage({ admin: true, sample: true, repo: { status: "ok", data: repoSample() } })).not.toContain("repoPollNow");
    expect(repoView(props({ tab: "ci", admin: true }))).not.toContain("repoPollNow");
  });

  it("a non-admin's header row is exactly what it was — nothing wraps the range buttons", () => {
    const html = usage({ admin: false });
    expect(html).toMatch(/App usage<\/span><div class="repo-seg"/);
  });

  it("while polling the button is disabled and says so; no strip yet", () => {
    const html = usage({ admin: true, poll: { status: "polling" } });
    expect(html).toMatch(/<button data-act="repoPollNow"[^>]* disabled[^>]*>Polling…<\/button>/);
    expect(html).not.toContain("repo-poll-strip");
  });

  it("an ok outcome's detail (dropped product keys) and a failed one's partial write are both said — escaped", () => {
    const html = usage({ admin: true, poll: done({
      cloudflare: "not_configured", railway: "not_configured",
      sapling: [
        { env: "staging", status: "ok", written: 7, detail: "2 keys dropped: counts.foo, totals.<b>" },
        { env: "production", status: "failed", written: 4, detail: "the windows do not nest (24h ≤ 7d ≤ 30d)" },
      ],
    }) });
    const text = html.slice(html.indexOf("repo-poll-strip")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("App metrics — staging ✓ 7 new — 2 keys dropped: counts.foo, totals.&lt;b&gt;");
    expect(text).toContain("production ✗ the windows do not nest (24h ≤ 7d ≤ 30d) — 4 new");
    expect(html).not.toContain("totals.<b>");
  });

  it("the strip gives one line per source: new rows, up to date, a failure's detail, a skip, not configured", () => {
    const html = usage({ admin: true, poll: done({
      cloudflare: [{ env: "staging", status: "ok", written: 3 }, { env: "production", status: "failed", written: 0, detail: "cloudflare analytics 403" }],
      railway: "not_configured",
      sapling: [{ env: "staging", status: "ok", written: 0 }, { env: "production", status: "skipped", written: 0, detail: "apiUrl is not https" }],
    }) });
    const text = html.slice(html.indexOf("repo-poll-strip")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Cloudflare — staging ✓ 3 new · production ✗ cloudflare analytics 403");
    expect(text).toContain("Railway — not configured");
    expect(text).toContain("App metrics — staging ✓ up to date · production – skipped: apiUrl is not https");
    expect(html).toContain('data-act="repoPollDismiss"');
    // Tone comes from the existing variables: good / bad / muted.
    expect(html).toMatch(/color:var\(--green\)[^>]*>✓ 3 new/);
    expect(html).toMatch(/color:var\(--red\)[^>]*>✗ cloudflare analytics 403/);
    expect(html).toMatch(/color:var\(--fg-40\)[^>]*>not configured/);
  });

  it("a source with no environment says so, and the unexpected-error arm reads as all environments", () => {
    const html = usage({ admin: true, poll: done({ ...NOT, cloudflare: [], sapling: [{ env: "*", status: "failed", written: 0, detail: "unexpected error" }] }) });
    const text = html.slice(html.indexOf("repo-poll-strip")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Cloudflare — no environment configured");
    expect(text).toContain("App metrics — all ✗ unexpected error");
  });

  it("never trusts a detail or an environment name as markup", () => {
    const html = usage({ admin: true, poll: done({ ...NOT, cloudflare: [{ env: `<b>stg</b>`, status: "failed", written: 0, detail: `<img src=x onerror=1>` }] }) });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>stg</b>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("&lt;b&gt;stg&lt;/b&gt;");
  });

  it("a failed request is one line, still dismissible", () => {
    const html = usage({ admin: true, poll: { status: "error" } });
    expect(html).toContain("Poll failed — try again.");
    expect(html).toContain('data-act="repoPollDismiss"');
    expect(html).toContain(">Poll now</button>"); // and the button is live again
  });

  it("the strip is for the Usage tab of the live dashboard only", () => {
    const poll = done(NOT);
    expect(repoView(props({ tab: "overview", admin: true, poll }))).not.toContain("repo-poll-strip");
    expect(usage({ admin: false, poll })).not.toContain("repo-poll-strip");
    expect(usage({ admin: true, poll, sample: true, repo: { status: "ok", data: repoSample() } })).not.toContain("repo-poll-strip");
  });

  it("render() hands the viewer's admin flag and the session-only poll state through", () => {
    const base = { ...initialState(), view: "app" as const, screen: "repo" as const, repoTab: "usage" as const, repo: { status: "ok" as const, data: live() } };
    const me = { handle: "andres", name: null, avatar_url: null, color: "green", identities: [], org: "SaplingLearn" };
    expect(render({ ...base, me: { ...me, admin: true } as typeof base.me })).toContain('data-act="repoPollNow"');
    expect(render({ ...base, me: { ...me, admin: false } as typeof base.me })).not.toContain("repoPollNow");
    expect(render({ ...base, me: { ...me, admin: true } as typeof base.me, repoPoll: { status: "error" } })).toContain("Poll failed — try again.");
  });
});

describe("helpers", () => {
  it("sparkPoints spans the box and survives a flat series", () => {
    expect(sparkPoints([1, 2, 3])).toBe("0.0,23.0 50.0,13.0 100.0,3.0");
    expect(sparkPoints([5, 5, 5])).not.toContain("NaN");
    expect(sparkPoints([1])).toBe("");
  });

  it("ago is the dense short form", () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    expect(ago("2026-09-20T11:59:50Z", now)).toBe("1m");
    expect(ago("2026-09-20T11:34:00Z", now)).toBe("26m");
    expect(ago("2026-09-20T09:00:00Z", now)).toBe("3h");
    expect(ago("2026-09-18T12:00:00Z", now)).toBe("2d");
    expect(ago("nope", now)).toBe("");
  });
});
