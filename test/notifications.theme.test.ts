/**
 * Email shell follows the site theme (light tokens from web/src/canopy.css,
 * flattened to hex, with a prefers-color-scheme dark swap). The Helvetica /
 * #00A859 / #f2f2f2 look from the original email mockup is gone.
 */
import { describe, it, expect } from "vitest";
import { assembleMessage, EMAIL_STYLE, THEME } from "../src/notifications/assemble";
import { sampleSections } from "../src/notifications/sample";

const window = { cadence: "daily" as const, id: "2026-09-13", start: new Date("2026-09-12T12:00:00Z"), end: new Date("2026-09-13T12:00:00Z") };
const msg = () =>
  assembleMessage({ sections: sampleSections(), window, timeZone: "America/New_York", origin: "https://canopy.example", login: "andres", unsubscribeUrl: "https://canopy.example/u/x.y" });

describe("email shell — site theming", () => {
  it("paints the light palette: cream ground, cream card, olive accent, warm ink", () => {
    const { html } = msg();
    expect(html).toContain("#f3f0e9"); // page ground
    expect(html).toContain("#faf8f3"); // card = site --bg (light)
    expect(html).toContain("#8a9a5b"); // site --accent (light)
    expect(html).toContain("#1a1814"); // site --fg (light)
  });

  it("drops the mockup's Helvetica / bright-green / grey look entirely", () => {
    const { html } = msg();
    expect(html).not.toContain("#00A859");
    expect(html).not.toContain("#f2f2f2");
    expect(html).not.toContain("font-family:Helvetica"); // the old bare stack; Geist stack may still fall back to it
    expect(html).not.toContain("Courier New");
  });

  it("uses the site type stack: Geist with a system fallback, Geist Mono for labels", () => {
    const { html } = msg();
    expect(html).toContain("fonts.googleapis.com/css2?family=Geist");
    expect(EMAIL_STYLE.body).toMatch(/font-family:Geist,/);
    expect(EMAIL_STYLE.label).toMatch(/font-family:'Geist Mono',/);
    expect(EMAIL_STYLE.label).toContain("text-transform:uppercase");
  });

  it("declares both color schemes and carries a dark swap the mail client can apply", () => {
    const { html } = msg();
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*#1c1a16[\s\S]*#ede9e2[\s\S]*#9aab65/);
  });

  it("keeps every section, its deep link and the unsubscribe link", () => {
    const { html, text, subject } = msg();
    expect(subject).toBe("Canopy daily, Sep 13");
    for (const s of sampleSections()) {
      expect(html).toContain(s.heading);
      expect(html).toContain(`https://canopy.example${s.deepLink}`);
    }
    expect(html).toContain("https://canopy.example/u/x.y");
    expect(text).toContain("Unsubscribe: https://canopy.example/u/x.y");
  });

  it("section renderers no longer carry hardcoded mockup greys", () => {
    const { html } = msg();
    expect(html).not.toContain("#8a8a8a");
    expect(html).not.toContain("#0a0a0a");
  });
});

describe("email header — Canopy branding", () => {
  it("renders the three-bar mark as HTML blocks (no SVG) with the wordmark beside it", () => {
    const { html } = msg();
    expect(html).not.toContain("<svg");
    expect(html).toContain('data-mark="canopy"');
    expect((html.match(/data-bar="/g) ?? []).length).toBe(3);
    expect(html).toMatch(/data-mark="canopy"[\s\S]*?Canopy<\/(span|strong|td)>/);
  });

  it("centres the header block: the mark table is align=center inside a text-align:center cell", () => {
    const { html } = msg();
    expect(html).toMatch(/<td[^>]*text-align:center[^>]*>[\s\S]*?<table[^>]*align="center"[^>]*>[\s\S]*?data-mark="canopy"/);
  });

  it("names the cadence under the wordmark: 'Daily digest · Sep 13'", () => {
    const { html } = msg();
    expect(html).toContain("Daily digest");
    expect(html).toContain("Sep 13");
  });
});

// WCAG 2.x relative luminance / contrast ratio, so the tokens are checked by number, not by eye.
function lum(hex: string): number {
  const c = hex.replace("#", "").match(/../g)!.map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("email contrast — action link", () => {
  it("the 'Open X →' text reaches 4.5:1 on the card in both palettes (small text, WCAG AA)", () => {
    expect(contrast(THEME.accentText.light, THEME.bg.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(THEME.accentText.dark, THEME.bg.dark)).toBeGreaterThanOrEqual(4.5);
  });

  it("the button uses the accentText token, not the raw accent", () => {
    const { html } = msg();
    expect(html).toMatch(new RegExp(`color:${THEME.accentText.light};text-decoration:none;padding:7px 13px`));
  });
});

describe("dark swap selectors", () => {
  it("text-colour rules are anchored so they cannot match background-color / border-color declarations", () => {
    const { html } = msg();
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    expect(css).not.toMatch(/\[style\*="color:#/); // a bare substring match would also hit "background-color:#…"
    expect(css).toMatch(/\[style\*=";color:#1a1814"\]/);
    expect(css).toMatch(/\[style\^="color:#1a1814"\]/);
  });
});
