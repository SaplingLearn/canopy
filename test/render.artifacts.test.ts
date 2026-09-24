/**
 * The Artifacts screens (web/src/artifacts.ts) — pure render + reducer tests.
 *
 * UI only for now: every screen reads the sample set (web/src/artifacts-sample.ts)
 * and every write edits the session copy. What matters here: each screen renders
 * from it, a private artifact is invisible to anyone but its author, the reducer's
 * gates hold (only the author makes an artifact private, only the latest published
 * version can be ratified, the 500 KB cap blocks an upload), and the preview is
 * labelled as one.
 */
import { describe, it, expect, vi } from "vitest";

// marked + DOMPurify need DOM globals this pool does not have (as in render.docs.test.ts):
// the stand-in marks that a markdown body went through the markdown function.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (b: string) => `<div data-md>${b.length}</div>`,
  renderMarkdownInline: (t: string) => t,
}));
import {
  artifactsView, artifactsHeader, artifactsDialogs, artifactsAct, libraryRows, parseArtLink, createBytes,
  initialArtUi, ART_ROUTE_NONE, ART_CAP, type ArtProps, type ArtUi, type ArtRoute, type ArtScreen,
} from "../web/src/artifacts";
import { sampleArtifacts, sampleRefs } from "../web/src/artifacts-sample";
import { render, initialState } from "../web/src/render";

function ui(over: Partial<ArtUi> = {}): ArtUi {
  return { ...initialArtUi(), items: sampleArtifacts(), ref: sampleRefs(), ...over };
}
function props(screen: ArtScreen, route: ArtRoute = ART_ROUTE_NONE, over: Partial<ArtProps> = {}): ArtProps {
  return { screen, route, ui: ui(), me: "AndresL230", persons: [], host: "canopy.test", ...over };
}
const view = (slug: string, v: number | null = null): ArtRoute => ({ slug, v, diff: null });
const ctx = (p: ArtProps) => ({ screen: p.screen, route: p.route, me: p.me, host: "https://canopy.test" });

describe("artifacts — library", () => {
  it("renders every visible sample as a card, labelled as a preview", () => {
    const html = artifactsView(props("artifacts"));
    expect(html).toContain("PREVIEW");
    expect((html.match(/data-act="artOpen"/g) ?? []).length).toBe(6);
    expect(html).toContain("6 shown · 6 total");
    expect(html).not.toMatch(/undefined|NaN|\[object/);
  });

  it("hides a private artifact from everyone but its author", () => {
    const other = props("artifacts", ART_ROUTE_NONE, { me: "lpcooper-arch" });
    expect(libraryRows(other).map((a) => a.slug)).not.toContain("canopy-artifact-store");
    expect(artifactsView(other)).toContain("5 shown · 5 total");
    expect(artifactsView(props("artifact", view("canopy-artifact-store"), { me: "lpcooper-arch" }))).toContain("This artifact isn't available.");
  });

  it("filters by search and by the filter popover, and says so when nothing matches", () => {
    const p = props("artifacts");
    artifactsAct(p.ui, ctx(p), "artFilterPick", "kind:markdown", null);
    expect(libraryRows(p).every((a) => a.kind === "markdown")).toBe(true);
    artifactsAct(p.ui, ctx(p), "artQ", null, "zzz-nothing");
    expect(artifactsView(p)).toContain("No artifacts match these filters.");
    artifactsAct(p.ui, ctx(p), "artFilterClear", null, null);
    expect(libraryRows(p).length).toBe(6);
    // A ticket number finds what is attached to it.
    artifactsAct(p.ui, ctx(p), "artQ", null, "#9");
    expect(libraryRows(p).map((a) => a.slug)).toEqual(["auth-audit-sep-2026"]);
  });

  it("shows a loading state until the sample set lands", () => {
    expect(artifactsView({ ...props("artifacts"), ui: initialArtUi() })).toContain("Loading artifacts");
  });

  it("puts New artifact in the header", () => {
    expect(artifactsHeader(props("artifacts")).controls).toContain('data-act="artNew"');
  });
});

describe("artifacts — viewer", () => {
  it("frames HTML in a script-less sandbox and renders markdown inline", () => {
    const html = artifactsView(props("artifact", view("google-signin-design")));
    expect(html).toContain('sandbox="allow-same-origin"');
    expect(html).not.toContain("allow-scripts");
    expect(artifactsView(props("artifact", view("auth-audit-sep-2026")))).toContain('<div class="cnpy-md" style="max-width:760px;margin:0 auto"><div data-md>');
  });

  it("an older version says so and offers the compare", () => {
    const html = artifactsView(props("artifact", view("google-signin-design", 1)));
    expect(html).toContain("older version");
    expect(html).toContain('data-act="artDiff" data-arg="google-signin-design:1..3"');
  });

  it("the author sees the private banner on their private draft", () => {
    expect(artifactsView(props("artifact", view("canopy-artifact-store")))).toContain("Only you can see this artifact.");
  });

  it("names the artifact in the header crumb, and Compare on a diff", () => {
    expect(artifactsHeader(props("artifact", view("auth-audit-sep-2026"))).crumb).toContain("Auth audit report");
    const d = artifactsHeader(props("artifact", { slug: "auth-audit-sep-2026", v: null, diff: { a: 1, b: 2 } })).crumb;
    expect(d).toContain('data-act="artOpen"');
    expect(d).toContain("Compare");
  });
});

describe("artifacts — reducer gates", () => {
  it("only the author may make an org artifact private", () => {
    const p = props("artifact", view("google-signin-design")); // Jose's
    expect(artifactsAct(p.ui, ctx(p), "artVis", null, null)).toBeNull();
    expect(p.ui.items!.find((a) => a.slug === "google-signin-design")!.visibility).toBe("org");
  });

  it("ratify opens only on the latest published version, and records the person", () => {
    const old = props("artifact", view("google-signin-design", 1));
    artifactsAct(old.ui, ctx(old), "artStatus", "ratified", null);
    expect(old.ui.ratifyOpen).toBe(false);

    const p = props("artifact", view("google-signin-design"));
    artifactsAct(p.ui, ctx(p), "artStatus", "ratified", null);
    expect(p.ui.ratifyOpen).toBe(true);
    expect(artifactsDialogs(p)).toContain("Ratify v3");
    expect(artifactsAct(p.ui, ctx(p), "artRatifyConfirm", null, null)).toEqual({ flash: "Ratified v3" });
    expect(p.ui.items!.find((a) => a.slug === "google-signin-design")!.ratified).toMatchObject({ v: 3, by: "AndresL230" });
  });

  it("attaches a ticket once", () => {
    const p = props("artifact", view("sprint-14-dashboard"));
    artifactsAct(p.ui, ctx(p), "artAttachOpen", null, null);
    artifactsAct(p.ui, ctx(p), "artAttachPick", "8", null); // already attached
    expect(p.ui.attachPick).toBeNull();
    artifactsAct(p.ui, ctx(p), "artAttachPick", "7", null);
    expect(artifactsAct(p.ui, ctx(p), "artAttachConfirm", null, null)).toEqual({ flash: "Attached to ticket #7" });
    expect(p.ui.items!.find((a) => a.slug === "sprint-14-dashboard")!.links.tickets).toEqual([8, 7]);
  });
});

describe("artifacts — new artifact", () => {
  it("parses the link forms the field accepts", () => {
    expect(parseArtLink("#10")).toMatchObject({ kind: "ticket", n: 10 });
    expect(parseArtLink("Sprint 14")).toMatchObject({ kind: "sprint", label: "Sprint 14" });
    expect(parseArtLink("https://github.com/SaplingLearn/canopy/pull/212")).toMatchObject({ kind: "PR", n: 212 });
    expect(parseArtLink("https://github.com/SaplingLearn/canopy/issues/9")).toMatchObject({ kind: "issue", n: 9 });
    expect(parseArtLink("hello")).toBeNull();
  });

  it("blocks an upload over the cap and warns on claude.ai-only calls", () => {
    const p = props("artifactnew");
    p.ui.c.title = "Big";
    p.ui.c.paste = "x".repeat(ART_CAP + 1);
    expect(createBytes(p.ui.c)).toBeGreaterThan(ART_CAP);
    expect(artifactsView(p)).toContain("Over the 500 KB cap.");
    expect(artifactsAct(p.ui, ctx(p), "artCSubmit", null, null)).toBeNull();

    p.ui.c.paste = "<script>window.claude.complete('x')</script>";
    expect(artifactsView(p)).toContain("CLAUDE.AI ONLY");
  });

  it("an upload lands first in the library as the person's v1 draft and opens it", () => {
    const p = props("artifactnew");
    p.ui.c.title = "Retro board";
    p.ui.c.paste = "# Retro";
    p.ui.c.kind = "markdown";
    const fx = artifactsAct(p.ui, ctx(p), "artCSubmit", null, null);
    expect(fx).toEqual({ nav: { screen: "artifact", route: { slug: "retro-board", v: null, diff: null } } });
    expect(p.ui.items![0]).toMatchObject({ slug: "retro-board", author: "AndresL230", status: "draft", versions: [{ v: 1 }] });
  });
});

describe("artifacts — in the app shell", () => {
  it("renders through render() with the sidebar lighting Artifacts", () => {
    const s = { ...initialState(), view: "app" as const, screen: "artifacts" as const, art: ui() };
    const html = render(s);
    expect(html).toContain('class="cnpy-navrow n-artifacts is-active"');
    expect(html).toContain("New artifact");
  });

  it("escapes a hostile title", () => {
    const p = props("artifacts");
    p.ui.items![0].title = `<img src=x onerror=alert(1)>`;
    expect(artifactsView(p)).not.toContain("<img src=x");
  });
});
