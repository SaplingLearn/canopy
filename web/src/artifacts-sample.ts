// The Artifacts screen's placeholder set — ported from the Claude Design
// `artifacts-data.js`. The artifact store (R2 bodies, D1 rows, the MCP upload
// tool) is not built yet, so every Artifacts screen reads THIS, and the screen
// labels it as a preview. A dynamic import (like repo-sample.ts), so none of it
// ships in the main bundle.
//
// The sample PAGES' own CSS writes `border-radius: Npx` with a space: it renders
// inside sandboxed iframes, outside canopy.css's corner layer, and the spelling
// keeps test/render.corners.test.ts (which scans every web/src template for the
// no-space form) from reading it as an app radius.
//
// People follow the repo's seed (scripts/seed/reset.mjs); tickets and sprints are
// the design's, not the live queue's.

import type { ArtRef, SampleArtifact } from "./artifacts";

/** The sample's people (the repo's seed), tickets and sprints (the design's). */
export function sampleRefs(): ArtRef {
  return {
    people: {
      "AndresL230": { name: "Andres", color: "moss" },
      "Jose-Gael-Cruz-Lopez": { name: "Jose", color: "sky" },
      "lpcooper-arch": { name: "Luke", color: "fern" },
      "Darkest-Teddy": { name: "Jack", color: "plum" },
      "meilin": { name: "Meilin Zhao", color: "rose" },
      "sanaok": { name: "Sana Okafor", color: "ochre" },
    },
    sprints: [
      { label: "Sprint 14", dates: "SEP 14 – SEP 27", active: true },
      { label: "Sprint 13", dates: "AUG 31 – SEP 13", active: false },
    ],
    tickets: [
      { id: 10, title: "Let non-engineers sign in with Google", status: "in_progress" },
      { id: 9, title: "Audit session and token handling before the Google rollout", status: "done" },
      { id: 8, title: "Sprint 14 review deck for Friday", status: "submitted" },
      { id: 7, title: "SSO login loops for one staff account", status: "in_progress" },
      { id: 3, title: "Add a “lesson duration” field to the curriculum planner", status: "submitted" },
      { id: 2, title: "Access to the staging environment for the QA pass", status: "in_progress" },
      { id: 1, title: "CSV export from the gradebook fails over 1,000 rows", status: "submitted" },
    ],
  };
}

const signin = (v: number): string => {
  const order = v === 1
    ? [`    <button class="btn primary">Continue with GitHub</button>`, `    <button class="btn ghost">Continue with Google</button>`]
    : [`    <button class="btn primary">Continue with Google</button>`, `    <button class="btn ghost">Continue with GitHub</button>`];
  const lead = v === 3
    ? `    <p>Use your school Google account. Engineers can keep using GitHub.</p>`
    : v === 2
      ? `    <p>Sign in with Google or GitHub to continue.</p>`
      : `    <p>Choose a provider to continue.</p>`;
  const hint = v >= 2 ? [`    <div class="hint">Only invited members of SaplingLearn can sign in.</div>`] : [];
  const notInvited = v >= 2 ? [
    ``,
    `  <section>`,
    `    <div class="label">Not invited</div>`,
    `    <div class="card">`,
    `      <h1>${v === 3 ? "You're not on the list yet" : "Access denied"}</h1>`,
    `      <p>${v === 3 ? "meilin@saplinglearn.com isn't invited to Canopy. Ask an admin to send you an invite." : "This account is not a member of the organization."}</p>`,
    `      <button class="btn ghost">Use a different account</button>`,
    `    </div>`,
    `  </section>`,
  ] : [];
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<title>Sign in · Canopy</title>`,
    `<style>`,
    `  body { margin:0; min-height:100vh; display:flex; gap:40px; align-items:center; justify-content:center; flex-wrap:wrap; padding:40px; box-sizing:border-box; background:#faf8f3; color:#1a1814; font-family:Geist, system-ui, sans-serif; }`,
    `  .label { font:500 10.5px 'Geist Mono', monospace; letter-spacing:.08em; text-transform:uppercase; color:rgba(26,24,20,.45); margin-bottom:10px; }`,
    `  .card { width:340px; padding:30px; border:1px solid rgba(42,39,31,.10); border-radius: 5px; background:#fff; box-sizing:border-box; }`,
    `  h1 { font-size:19px; font-weight:600; letter-spacing:-.01em; margin:0 0 6px; }`,
    `  p { font-size:13.5px; color:rgba(26,24,20,.62); margin:0 0 22px; line-height:1.5; }`,
    `  .btn { display:flex; align-items:center; justify-content:center; width:100%; height:40px; border-radius: 3px; font:600 13.5px Geist, system-ui; cursor:pointer; }`,
    `  .primary { background:#1a1814; color:#faf8f3; border:none; }`,
    `  .ghost { background:none; border:1px solid rgba(42,39,31,.18); color:#1a1814; margin-top:10px; }`,
    `  .hint { font-size:12px; color:rgba(26,24,20,.45); margin-top:18px; text-align:center; }`,
    `</style>`,
    `</head>`,
    `<body>`,
    `  <section>`,
    `    <div class="label">Default</div>`,
    `    <div class="card">`,
    `    <h1>Sign in to Canopy</h1>`,
    lead,
    ...order,
    ...hint,
    `    </div>`,
    `  </section>`,
    ...notInvited,
    `</body>`,
    `</html>`,
  ].join("\n");
};

const dashboard = [
  `<!doctype html>`,
  `<html lang="en">`,
  `<head>`,
  `<meta charset="utf-8">`,
  `<title>Sprint 14 · snapshot</title>`,
  `<style>`,
  `  body { margin:0; padding:30px 34px; background:#faf8f3; color:#1a1814; font-family:Geist, system-ui, sans-serif; }`,
  `  h1 { font-size:20px; font-weight:600; letter-spacing:-.01em; margin:0; }`,
  `  h2 { font-size:14px; font-weight:600; margin:26px 0 8px; }`,
  `  .sub { font:500 10.5px 'Geist Mono', monospace; letter-spacing:.08em; text-transform:uppercase; color:rgba(26,24,20,.45); margin-top:7px; }`,
  `  .kpis { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-top:22px; }`,
  `  .k { border:1px solid rgba(42,39,31,.10); border-radius: 4px; padding:14px 16px; background:#fff; }`,
  `  .k b { display:block; font-size:24px; font-weight:600; letter-spacing:-.02em; }`,
  `  .k span { font-size:12px; color:rgba(26,24,20,.55); }`,
  `  .row { display:grid; grid-template-columns:120px 1fr 44px; gap:14px; align-items:center; font-size:13px; padding:6px 0; }`,
  `  .bar { height:6px; background:rgba(42,39,31,.08); border-radius: 2px; }`,
  `  .bar i { display:block; height:100%; background:#8a9a5b; border-radius: 2px; }`,
  `  .n { font:500 12px 'Geist Mono', monospace; text-align:right; color:rgba(26,24,20,.55); }`,
  `</style>`,
  `</head>`,
  `<body>`,
  `  <h1>Sprint 14, mid-sprint snapshot</h1>`,
  `  <div class="sub">Sep 14 – Sep 27 · captured Sep 22, 18:00 UTC</div>`,
  `  <div class="kpis">`,
  `    <div class="k"><b>11 / 19</b><span>tickets done</span></div>`,
  `    <div class="k"><b>14</b><span>PRs merged</span></div>`,
  `    <div class="k"><b>6</b><span>deploys to production</span></div>`,
  `    <div class="k"><b>2</b><span>tickets unassigned</span></div>`,
  `  </div>`,
  `  <h2>Done by area</h2>`,
  `  <div class="row"><span>auth</span><div class="bar"><i style="width:83%"></i></div><span class="n">5/6</span></div>`,
  `  <div class="row"><span>ui</span><div class="bar"><i style="width:60%"></i></div><span class="n">3/5</span></div>`,
  `  <div class="row"><span>api</span><div class="bar"><i style="width:67%"></i></div><span class="n">2/3</span></div>`,
  `  <div class="row"><span>data</span><div class="bar"><i style="width:33%"></i></div><span class="n">1/3</span></div>`,
  `  <div class="row"><span>infra</span><div class="bar"><i style="width:0%"></i></div><span class="n">0/2</span></div>`,
  `</body>`,
  `</html>`,
].join("\n");

const auditV1 = `# Auth audit, September 2026

Scope: the session cookie, the GitHub OAuth callback, and MCP bearer tokens. Reviewed against \`src/auth/\` at the head of \`main\`.

## Summary

| Area | Finding | Severity |
|---|---|---|
| Session cookie | Signed, \`HttpOnly\`, \`Secure\`, \`SameSite=Lax\` | OK |
| OAuth state | State param checked on the callback | OK |
| MCP tokens | Stored hashed; no expiry | Low |

## Findings

### MCP tokens never expire
Tokens are revocable from Settings, but a lost laptop keeps a working token until someone notices.

1. Show \`last_used_at\` in the token list.
2. Propose a 90-day idle expiry.

## Out of scope
- Cloudflare account access
- GitHub org membership policy`;

const auditV2 = `# Auth audit, September 2026

Scope: the session cookie, the GitHub and Google OAuth callbacks, and MCP bearer tokens. Reviewed against \`src/auth/\` at the head of \`main\`.

## Summary

| Area | Finding | Severity |
|---|---|---|
| Session cookie | Signed, \`HttpOnly\`, \`Secure\`, \`SameSite=Lax\` | OK |
| OAuth state | State param checked on both callbacks | OK |
| Google provider | \`hd\` claim not enforced on callback | Medium |
| MCP tokens | Stored hashed; no expiry | Low |

## Findings

### Google \`hd\` claim is advisory
The Google callback trusts the hosted-domain hint from the authorize URL, so a personal account can complete the flow. Membership is still checked against the invite list, so this does not grant access, but the error page it lands on is wrong.

> Fix: verify \`hd\` from the ID token, not from the request.

### MCP tokens never expire
Tokens are revocable from Settings, but a lost laptop keeps a working token until someone notices.

1. Show \`last_used_at\` in the token list (shipped in #205).
2. Propose a 90-day idle expiry.

## Out of scope
- Cloudflare account access
- GitHub org membership policy`;

const specV1 = `# Canopy artifact store

An artifact is one self-contained page an agent produced: a design page, a spec, an audit report, a dashboard snapshot. Canopy stores it, versions it, and links it to the work it came from.

## Kinds

- \`html\`: rendered in a sandboxed frame
- \`markdown\`: rendered inline with the docs typography
- \`svg\`: rendered in a frame
- \`mermaid\`: rendered inline as a diagram

## Storage

Bodies live in R2, keyed by \`slug/version\`. D1 keeps the row: title, kind, area, repo, author, status, visibility.

## Limits

One file per artifact, 500 KB max.`;

const specV2 = `# Canopy artifact store

An artifact is one self-contained page an agent produced: a design page, a spec, an audit report, a dashboard snapshot. Canopy stores it, versions it, and links it to the work it came from.

## Kinds

- \`html\`: rendered in a sandboxed frame, no network, no \`window.claude\`
- \`markdown\`: rendered inline with the docs typography
- \`svg\`: rendered in a frame
- \`mermaid\`: rendered inline as a diagram

## Storage

Bodies live in R2, keyed by \`slug/version\`. D1 keeps the row: title, kind, area, repo, author, status, visibility, and one row per version.

## Lifecycle

1. An agent uploads a **draft**. Private to its author until published.
2. The author publishes it to the org.
3. A person **ratifies** a published version. Agents can't ratify.

## Limits

One file per artifact, 500 KB max. Pages that call \`window.claude\`, \`window.storage\` or \`api.anthropic.com\` upload with a warning; those calls fail in the sandbox.`;

const archV1 = `flowchart LR
  agent[Claude Code session] -->|MCP| worker[Cloudflare Worker]
  browser[Canopy SPA] -->|HTTP| worker
  worker --> gate[Gate: consumer.ts]
  gate --> d1[(D1)]
  worker --> fts[(FTS5 index)]
  worker --> gh[GitHub API]`;

const archV2 = `flowchart LR
  agent[Claude Code session] -->|MCP| worker[Cloudflare Worker]
  browser[Canopy SPA] -->|HTTP| worker
  worker --> gate[Gate: consumer.ts]
  gate --> d1[(D1)]
  worker --> fts[(FTS5 index)]
  worker --> gh[GitHub API]
  gate --> r2[(R2: artifact bodies)]
  worker --> r2`;

const tokenSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 220" width="660" height="220" font-family="Geist, system-ui, sans-serif" font-size="13" fill="none" stroke="currentColor">
  <rect x="20" y="82" width="150" height="56" rx="3" stroke-opacity=".35"/>
  <text x="95" y="115" text-anchor="middle" fill="currentColor" stroke="none">Browser</text>
  <rect x="255" y="82" width="150" height="56" rx="3" stroke-opacity=".35"/>
  <text x="330" y="115" text-anchor="middle" fill="currentColor" stroke="none">Worker /auth</text>
  <rect x="490" y="82" width="150" height="56" rx="3" stroke-opacity=".35"/>
  <text x="565" y="115" text-anchor="middle" fill="currentColor" stroke="none">Google OAuth</text>
  <line x1="170" y1="100" x2="255" y2="100" stroke-opacity=".55"/>
  <line x1="405" y1="100" x2="490" y2="100" stroke-opacity=".55"/>
  <line x1="490" y1="122" x2="405" y2="122" stroke-opacity=".55" stroke-dasharray="4 4"/>
  <line x1="255" y1="122" x2="170" y2="122" stroke-opacity=".55" stroke-dasharray="4 4"/>
  <text x="212" y="74" text-anchor="middle" fill="currentColor" stroke="none" font-size="11" opacity=".6">/auth/google</text>
  <text x="447" y="74" text-anchor="middle" fill="currentColor" stroke="none" font-size="11" opacity=".6">authorize + state</text>
  <text x="447" y="158" text-anchor="middle" fill="currentColor" stroke="none" font-size="11" opacity=".6">code → ID token</text>
  <text x="212" y="158" text-anchor="middle" fill="currentColor" stroke="none" font-size="11" opacity=".6">signed session cookie</text>
</svg>`;

/** A fresh copy every call: the preview mutates its session copy (publish, ratify,
 *  attach, upload), and reloading the screen should not inherit those edits. */
export function sampleArtifacts(): SampleArtifact[] {
  const list: Omit<SampleArtifact, "ratified">[] = [
    {
      slug: "google-signin-design", title: "Google sign-in design page", kind: "html", area: "ui", repo: "SaplingLearn/canopy",
      author: "Jose-Gael-Cruz-Lopez", status: "published", visibility: "org",
      links: { tickets: [10], sprints: ["Sprint 14"], issues: [198], prs: [212] },
      versions: [
        { v: 1, by: "Jose-Gael-Cruz-Lopez", when: "5d ago", summary: "First pass: provider buttons and layout", src: signin(1) },
        { v: 2, by: "lpcooper-arch", when: "3d ago", summary: "Adds the not-invited state", src: signin(2) },
        { v: 3, by: "Jose-Gael-Cruz-Lopez", when: "2h ago", summary: "Google first, school-account copy", src: signin(3) },
      ],
    },
    {
      slug: "auth-audit-sep-2026", title: "Auth audit report", kind: "markdown", area: "auth", repo: "SaplingLearn/canopy",
      author: "lpcooper-arch", status: "ratified", visibility: "org",
      links: { tickets: [9, 10], sprints: ["Sprint 13"], issues: [], prs: [205] },
      versions: [
        { v: 1, by: "lpcooper-arch", when: "9d ago", summary: "Cookie, OAuth state and MCP token review", src: auditV1 },
        { v: 2, by: "lpcooper-arch", when: "6d ago", summary: "Adds the Google provider finding", src: auditV2 },
      ],
    },
    {
      slug: "sprint-14-dashboard", title: "Sprint 14 dashboard snapshot", kind: "html", area: "data", repo: "SaplingLearn/canopy",
      author: "AndresL230", status: "published", visibility: "org",
      links: { tickets: [8], sprints: ["Sprint 14"], issues: [], prs: [] },
      versions: [{ v: 1, by: "AndresL230", when: "1d ago", summary: "Mid-sprint snapshot", src: dashboard }],
    },
    {
      slug: "canopy-artifact-store", title: "Canopy artifact store spec", kind: "markdown", area: "architecture", repo: "SaplingLearn/canopy",
      author: "AndresL230", status: "draft", visibility: "private",
      links: { tickets: [], sprints: ["Sprint 14"], issues: [221], prs: [] },
      versions: [
        { v: 1, by: "AndresL230", when: "4d ago", summary: "Kinds, storage, limits", src: specV1 },
        { v: 2, by: "AndresL230", when: "5h ago", summary: "Lifecycle and the claude.ai warning", src: specV2 },
      ],
    },
    {
      slug: "canopy-architecture", title: "Canopy architecture diagram", kind: "mermaid", area: "architecture", repo: "SaplingLearn/canopy",
      author: "Jose-Gael-Cruz-Lopez", status: "published", visibility: "org",
      links: { tickets: [], sprints: ["Sprint 14"], issues: [], prs: [219] },
      versions: [
        { v: 1, by: "Jose-Gael-Cruz-Lopez", when: "12d ago", summary: "Worker, gate, D1, FTS", src: archV1 },
        { v: 2, by: "AndresL230", when: "2d ago", summary: "Adds R2 for artifact bodies", src: archV2 },
      ],
    },
    {
      slug: "google-session-flow", title: "Google session token flow", kind: "svg", area: "auth", repo: "SaplingLearn/canopy",
      author: "Darkest-Teddy", status: "draft", visibility: "org",
      links: { tickets: [7], sprints: ["Sprint 14"], issues: [], prs: [] },
      versions: [{ v: 1, by: "Darkest-Teddy", when: "3h ago", summary: "Browser → Worker → Google round trip", src: tokenSvg }],
    },
  ];
  return list.map((a) => ({
    ...a,
    ratified: a.status === "ratified" ? { v: a.versions[a.versions.length - 1].v, by: "AndresL230", when: "5d ago" } : null,
  }));
}
