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
import { REPO_TABS, type RepoDashboard } from "@shared/repo";

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
    expect(html).toContain("No merges or closes this week.");
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
    expect(withEnvs).toContain("main — healthy");
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
