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
import { REPO_TABS, type RepoDashboard, type RepoPerson } from "@shared/repo";

const NC = { status: "not_connected" } as const;
const EMPTY = { status: "empty" } as const;

/** What the Worker returns today for an empty store. */
function live(over: Partial<RepoDashboard> = {}): RepoDashboard {
  return {
    repo: "SaplingLearn/sapling", generatedAt: new Date().toISOString(), degraded: false,
    environments: NC, drift: NC, health: NC, branches: NC, deploys: NC, ciFailures: NC, coverage: NC, bundle: NC,
    usage: NC, cloudflare: NC, hosting: NC, todos: NC,
    stats: EMPTY, codeStats: EMPTY, bars: EMPTY, prs: EMPTY, activity: EMPTY, sprint: EMPTY, contributors: EMPTY, labels: EMPTY,
    ...over,
  };
}

function props(over: Partial<RepoProps> = {}): RepoProps {
  return { tab: "overview", range: "7d", driftOpen: false, repo: { status: "ok", data: live() }, fetchedAt: Date.now(), sample: false, ...over };
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

  it("shows 'Source not connected' for a section with no capture path, with no dead button", () => {
    const html = repoView(props({ tab: "usage" }));
    expect((html.match(/Source not connected/g) ?? []).length).toBe(3);
    expect(html).not.toContain("Connect Cloudflare");
    expect(html).toContain('data-act="repoSampleOn"');
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
          active: 1, stale: 1,
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
    expect(html).toContain("+4 / −0 vs main");
    expect(html).toContain("+7 / −31 vs main");
    expect(html).toContain("STALE");
    expect(html).toContain("1 active · 1 stale");
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
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: { value: "12.4K", trend: [1, 2, 3], tone: "neutral" as const }, errorRate: { value: "2.41%", trend: [1, 2], tone: "warn" as const }, users: null };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } } });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect(html).toContain("12.4K");
    expect(html).toContain("Active users");
    expect(html).toContain("not connected");
  });

  it("a usage env with every metric unconnected still renders its name, host, and three not-connected rows", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: null };
    const data = live({
      usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } },
      cloudflare: EMPTY, hosting: EMPTY,
    });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect(html).toContain("staging");
    expect(html).toContain("staging.saplinglearn.com");
    expect((html.match(/not connected/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/undefined|NaN/);
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
