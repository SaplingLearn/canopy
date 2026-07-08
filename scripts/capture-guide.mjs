// Capture the Get Started guide screenshots against the real (cookie-gated) app over
// `wrangler dev`, in ONE headless Chrome session, at 2× device scale for crisp images.
// Verification/authoring-only; no app code depends on it. Companion to dev-shot.mjs —
// this one knows the guide's surface list and the framing each shot needs (nav click,
// doc to open, query to type, section to scroll to).
//
//   1. seed + run the app:   npm run seed && npm run dev   (DEV_LOGIN=AndresL230 in .dev.vars)
//   2. capture every figure:  node scripts/capture-guide.mjs
//
// Writes web/public/guide/<name>-<theme>.png for each surface × theme (dark/light/midnight),
// so the guide can show the variant matching the viewer's active theme. Override the target
// dir with CANOPY_SHOT_DIR, the base URL with CANOPY_URL, the Chrome binary with CHROME_BIN,
// or the theme list with CANOPY_THEMES (comma-separated).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN ?? "/home/andresl/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
const PORT = Number(process.env.CDP_PORT ?? 9334);
const BASE = process.env.CANOPY_URL ?? "http://localhost:8787";
const OUT_DIR = process.env.CANOPY_SHOT_DIR ?? join(HERE, "..", "web", "public", "guide");
const VIEW = { width: 1280, height: 800, deviceScaleFactor: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Forge the dev session cookie the same way scripts/dev-cookie.mjs does, so the SPA's
// same-origin fetches are authed even if DEV_LOGIN weren't set.
async function forgeCookie() {
  const devVars = readFileSync(join(HERE, "..", ".dev.vars"), "utf8");
  const line = devVars.split("\n").find((l) => l.startsWith("COOKIE_SECRET="));
  if (!line) throw new Error("COOKIE_SECRET not found in .dev.vars");
  const secret = line.slice("COOKIE_SECRET=".length).trim().replace(/^["']|["']$/g, "");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("devsession"));
  const b64url = Buffer.from(sig).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `devsession.${b64url}`;
}

// Each figure: a name, the in-page JS to set it up (click a nav item, open a doc, type a
// query, scroll a section into view), and how long to let async fetches + layout settle.
const SHOTS = [
  { name: "mywork", settle: 1600,
    // Explicit nav — a per-theme reload may restore a different screen from the URL hash.
    setup: `document.querySelector('[data-act=goMyWork]').click(); window.scrollTo(0,0)` },
  { name: "roadmap", settle: 1500,
    setup: `document.querySelector('[data-act=goRoadmap]').click()` },
  { name: "feed", settle: 1500,
    setup: `document.querySelector('[data-act=goFeed]').click()` },
  { name: "docs", settle: 1900,
    // Docs opens on the Technical space and auto-selects the first doc (sapling-architecture)
    // with its heading outline expanded in the tree. That doc also has a staged version, so
    // one frame shows the new per-page outline tree AND the "proposal awaiting review" banner.
    setup: `document.querySelector('[data-act=goDocs]').click()` },
  { name: "search", settle: 1700,
    setup: `document.querySelector('[data-act=goSearch]').click();
            setTimeout(()=>{const i=document.querySelector('input[data-act=setSearch]'); if(i){i.value='gate'; i.dispatchEvent(new Event('input',{bubbles:true}));}}, 500)` },
  { name: "review", settle: 1600,
    setup: `document.querySelector('[data-act=goReview]').click()` },
  { name: "maintenance", settle: 1600,
    setup: `document.querySelector('[data-act=goMaintenance]').click()` },
  { name: "settings", settle: 1400,
    // Focus the MCP access tokens section (the "mint a token" step the guide points to).
    setup: `document.querySelector('[data-act=goSettings]').click();
            setTimeout(()=>{const b=document.querySelector('[data-act=mintToken]'); if(b) b.closest('section').scrollIntoView({block:'start'}); window.scrollBy(0,-24);}, 600)` },
];

// Optional argv filter: `node scripts/capture-guide.mjs docs search` captures only those.
const only = process.argv.slice(2);
const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

const COOKIE = await forgeCookie();
mkdirSync(OUT_DIR, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "canopy-guide-"))}`,
  `--window-size=${VIEW.width},${VIEW.height}`, "about:blank",
], { stdio: "ignore" });

async function targetWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("CDP page target not found");
}

const ws = new WebSocket(await targetWs());
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await cmd("Page.enable");
await cmd("Runtime.enable");
await cmd("Emulation.setDeviceMetricsOverride", { ...VIEW, mobile: false });
const host = new URL(BASE).hostname;
await cmd("Network.setCookie", { name: "session", value: COOKIE, domain: host, path: "/" });
await cmd("Page.navigate", { url: BASE });
await sleep(2600); // SPA boot (getMe) + first data fetch — establishes the origin for localStorage

// Capture every surface in each theme, so the guide can pick the variant matching the
// viewer's active theme. The SPA reads localStorage 'canopy.theme' on boot, so we set it
// then reload; filenames get a -<theme> suffix.
const THEMES = (process.env.CANOPY_THEMES ?? "dark,light,midnight").split(",").map((t) => t.trim()).filter(Boolean);

for (const theme of THEMES) {
  await cmd("Runtime.evaluate", { expression: `localStorage.setItem('canopy.theme', ${JSON.stringify(theme)})` });
  await cmd("Page.reload", {});
  await sleep(2600); // re-boot in the new theme
  for (const shot of shots) {
    await cmd("Runtime.evaluate", { expression: shot.setup });
    await sleep(shot.settle);
    const png = await cmd("Page.captureScreenshot", { format: "png" });
    const path = join(OUT_DIR, `${shot.name}-${theme}.png`);
    writeFileSync(path, Buffer.from(png.result.data, "base64"));
    process.stdout.write(`${path}\n`);
  }
}

chrome.kill();
process.exit(0);
