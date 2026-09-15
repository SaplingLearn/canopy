/**
 * Feed screen render test — the handle-carries-color task: a feed row's chip AND
 * its author handle text are both rendered in the mapped person's color, and the
 * header's author-filter chip for that person carries the same color.
 *
 * Pure (no D1 / Miniflare); assertions are HTML-string based, over a real render()
 * pass with the feed screen active.
 */
import { describe, it, expect } from "vitest";
import { render, initialState } from "../web/src/render";
import type { FeedRow } from "@shared/rows";

function feedRow(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    id: 1,
    author: "AndresL230",
    summary: "Shipped the colored-handle change.",
    body: null,
    artifacts: null,
    created_at: "2026-09-14T10:00:00Z",
    ...overrides,
  };
}

function feedState(rows: FeedRow[]): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "feed",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], org: "SaplingLearn", admin: false },
    persons: { status: "ok", data: [{ handle: "AndresL230", name: "Andres", color: "moss", avatar_url: null }] },
    feed: { status: "ok", data: rows },
    feedAuthors: [...new Set(rows.map((r) => r.author))],
  };
}

describe("Feed — handle text carries the mapped person's color", () => {
  it("a feed row by a mapped author shows the color on both the chip and the handle text", () => {
    const html = render(feedState([feedRow()]));
    const occurrences = (html.match(/var\(--p-moss\)/g) ?? []).length;
    // Once for the colored chip's --c background var, once for the handleTag text.
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(html).toContain("@AndresL230");
  });

  it("the author filter chip for that person also carries their color", () => {
    const html = render(feedState([feedRow()]));
    expect(html).toContain('data-act="setAuthor" data-arg="AndresL230"');
    // The achip button and the feed row both contribute var(--p-moss) occurrences;
    // isolate the header controls to confirm the filter chip itself is colored.
    const headerStart = html.indexOf("<header");
    const headerEnd = html.indexOf("</header>");
    const headerHtml = html.slice(headerStart, headerEnd);
    expect(headerHtml).toContain("var(--p-moss)");
  });

  it("an unmapped author renders a muted handle with no person color", () => {
    const html = render(feedState([feedRow({ author: "octo-stranger" })]));
    expect(html).toContain("@octo-stranger");
    expect(html).not.toContain("var(--p-moss)");
  });
});
