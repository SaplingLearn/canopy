/**
 * Email shell follows the site theme (light tokens from web/src/canopy.css,
 * flattened to hex, with a prefers-color-scheme dark swap). The Helvetica /
 * #00A859 / #f2f2f2 look from the original email mockup is gone.
 */
import { describe, it, expect } from "vitest";
import { assembleMessage, EMAIL_STYLE } from "../src/notifications/assemble";
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

  it("names the cadence under the wordmark: 'Daily digest · Sep 13'", () => {
    const { html } = msg();
    expect(html).toContain("Daily digest");
    expect(html).toContain("Sep 13");
  });
});
