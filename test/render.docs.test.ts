/**
 * Docs screen render tests — the space toggle is a FIXED {Technical, Product}
 * two-tab set. The tabs must NOT be derived from the data: exactly two tabs
 * render, always, and a doc carrying a foreign `space` can never add a third tab.
 *
 * Pure (no D1 / Miniflare); assertions are HTML-string based. markdown is mocked
 * for the same reason as the other render tests (DOMPurify needs DOM globals).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body}</div>`,
}));

import { render, initialState, DOC_SPACES } from "../web/src/render";
import type { DocRow } from "@shared/rows";

function doc(overrides: Partial<DocRow> = {}): DocRow {
  return {
    slug: "a-doc",
    section: "reference",
    title: "A Doc",
    body: "body",
    current_version: 1,
    updated_at: "2026-07-01T00:00:00Z",
    updated_by: "agent",
    space: "technical",
    ...overrides,
  };
}

function docsState(docs: DocRow[]): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "docs",
    me: { login: "alice", name: "Alice", avatar_url: null, org: "SaplingLearn", admin: false },
    docsList: { status: "ok", data: docs },
  };
}

describe("Docs space toggle — fixed two-tab set", () => {
  it("DOC_SPACES is exactly ['technical', 'product'] in order", () => {
    expect([...DOC_SPACES]).toEqual(["technical", "product"]);
  });

  it("renders exactly the Technical and Product tabs", () => {
    const html = render(docsState([doc()]));
    expect(html).toContain('data-act="setDocSpace" data-arg="technical"');
    expect(html).toContain(">Technical<");
    expect(html).toContain('data-act="setDocSpace" data-arg="product"');
    expect(html).toContain(">Product<");
  });

  it("both tabs render even when the data has only one space present", () => {
    // Data-derived tabs would have hidden the empty tab (old length>1 guard);
    // the fixed set always shows both.
    const html = render(docsState([doc({ space: "technical" })]));
    expect(html).toContain('data-arg="technical"');
    expect(html).toContain('data-arg="product"');
  });

  it("a doc with a foreign space never adds a third tab", () => {
    const html = render(docsState([doc({ slug: "stray", space: "sapling" })]));
    expect(html).not.toContain('data-arg="sapling"');
    // Only the two canonical setDocSpace tabs exist.
    const tabCount = (html.match(/data-act="setDocSpace"/g) ?? []).length;
    expect(tabCount).toBe(2);
  });
});
