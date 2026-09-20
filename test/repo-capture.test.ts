import { describe, it, expect } from "vitest";
import { repoEventsFromDelivery } from "../src/repo/capture";
import { ENVS } from "./helpers/repo";
import push from "./fixtures/gh-push.json";
import prOpened from "./fixtures/gh-pr-opened.json";
import prMerged from "./fixtures/gh-pr-merged.json";


describe("repoEventsFromDelivery — push", () => {
  it("captures a branch push: distinct commit count, head subject, pusher", () => {
    const [ev, ...rest] = repoEventsFromDelivery("push", push, ENVS);
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({
      semantic_key: "gh:push:becdbac09eaf5d7c73b9f27019c0e43c4444dd7b:main", kind: "push", ref: "main",
      sha: "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", actor_login: "AndresL230", count: 2,
      title: "fix window math", provenance: "webhook",
      // repository.pushed_at (1789895090 unix seconds) converts to this instant —
      // NOT the head commit's own (earlier-authored) 09:04:41Z timestamp. A
      // rebase/cherry-pick would otherwise land the push in an old day bucket.
      occurred_at: "2026-09-20T09:04:50Z",
    });
    // raw keeps a slice, never the whole delivery
    expect(JSON.parse(ev.raw).commits).toHaveLength(3);
    expect(ev.raw).not.toContain("body");
  });

  it("falls back to the head commit timestamp when repository.pushed_at is absent or not a finite number", () => {
    const [noRepo] = repoEventsFromDelivery("push", { ...push, repository: undefined }, ENVS);
    expect(noRepo.occurred_at).toBe("2026-09-20T09:04:41Z");
    const [junkPushedAt] = repoEventsFromDelivery("push", { ...push, repository: { pushed_at: "not-a-number" } }, ENVS);
    expect(junkPushedAt.occurred_at).toBe("2026-09-20T09:04:41Z");
  });

  it("ignores tag pushes and branch deletions", () => {
    expect(repoEventsFromDelivery("push", { ...push, ref: "refs/tags/v1" }, ENVS)).toEqual([]);
    expect(repoEventsFromDelivery("push", { ...push, deleted: true }, ENVS)).toEqual([]);
  });
});

describe("repoEventsFromDelivery — pull_request", () => {
  it("maps open/draft/merged/closed onto one `state` column", () => {
    const state = (over: object, action = "opened") =>
      repoEventsFromDelivery("pull_request", { ...prOpened, action, pull_request: { ...prOpened.pull_request, ...over } }, ENVS)[0]?.state;
    expect(state({})).toBe("review");
    expect(state({ draft: true })).toBe("draft");
    expect(state({ state: "closed", merged: true }, "closed")).toBe("merged");
    expect(state({ state: "closed", merged: false }, "closed")).toBe("closed");
  });

  it("keys on action + updated_at so a redelivery collapses and a later edit does not", () => {
    const [ev] = repoEventsFromDelivery("pull_request", prOpened, ENVS);
    expect(ev).toMatchObject({
      semantic_key: "gh:prs:482:opened:2026-09-20T09:10:00Z", kind: "pr", number: 482, ref: "feature/usage-rollup",
      sha: "c91d2aec91d2aec91d2aec91d2aec91d2aec91d2", actor_login: "lpcooper-arch", title: "Batch D1 reads in usage rollup",
    });
  });

  it("skips actions that change nothing the dashboard shows", () => {
    for (const action of ["labeled", "assigned", "review_requested", "locked"]) {
      expect(repoEventsFromDelivery("pull_request", { ...prOpened, action }, ENVS)).toEqual([]);
    }
  });

  it("returns [] for junk", () => {
    expect(repoEventsFromDelivery("pull_request", null, ENVS)).toEqual([]);
    expect(repoEventsFromDelivery("ping", {}, ENVS)).toEqual([]);
  });

  it("falls back to merged_at / closed_at when a payload slice carries no updated_at", () => {
    const [ev] = repoEventsFromDelivery("pull_request", prMerged, ENVS);
    expect(ev).toMatchObject({ kind: "pr", state: "merged" });
    expect(ev.occurred_at).toBe((prMerged as { pull_request: { merged_at: string } }).pull_request.merged_at);
  });
});
