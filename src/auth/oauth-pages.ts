// The three pages the OAuth flow renders from the Worker (not the SPA, so the flow
// never depends on the web bundle loading). Pure string templates; every dynamic
// value is escaped. Colours are Canopy's light/dark tokens (web/src/canopy.css).

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const CSS = `
:root{--bg:#faf8f3;--fg:#1a1814;--fg-55:rgba(26,24,20,.55);--border:rgba(42,39,31,.18);--accent:#8a9a5b;--accent-fg:#fff;--red:#a83a3a}
@media (prefers-color-scheme:dark){:root{--bg:#1c1a16;--fg:#ede9e2;--fg-55:rgba(237,233,226,.55);--border:rgba(237,233,226,.2);--accent:#9aab65;--accent-fg:#131a07;--red:#cc6262}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
.card{width:100%;max-width:420px;border:1px solid var(--border);border-radius:5px;padding:28px}
h1{font-size:19px;margin:0 0 10px;font-weight:600}p{margin:0 0 14px}.muted{color:var(--fg-55);font-size:13px}
.brand{font-weight:600;letter-spacing:.02em;margin-bottom:18px;color:var(--accent)}
.row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
.btn{flex:1;display:inline-block;text-align:center;padding:10px 14px;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.err{color:var(--red)}code{font-size:13px}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)} · Canopy</title><style>${CSS}</style></head><body><main class="card"><div class="brand">Canopy</div>${body}</main></body></html>`;
}

export function errorPage(message: string): string {
  return shell("Can't connect", `<h1>Can't connect this app</h1><p class="err">${esc(message)}</p><p class="muted">You can close this tab.</p>`);
}

export function signInPage(clientName: string): string {
  return shell("Sign in", `<h1>Sign in to connect ${esc(clientName)}</h1>`
    + `<p class="muted">After you sign in, Canopy asks you to confirm before anything is connected.</p>`
    + `<div class="row"><a class="btn primary" href="/auth/login">Continue with GitHub</a><a class="btn" href="/auth/google/login">Continue with Google</a></div>`);
}

export function consentPage(p: { clientName: string; redirectHost: string; handle: string; hidden: Record<string, string>; csrf: string }): string {
  const inputs = Object.entries({ ...p.hidden, csrf: p.csrf })
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return shell("Connect an app", `<h1>Connect ${esc(p.clientName)}?</h1>`
    + `<p class="muted">Name supplied by the app. It will return you to <code>${esc(p.redirectHost)}</code>.</p>`
    + `<p>It will act as <strong>@${esc(p.handle)}</strong>. It can do everything you can do in Canopy through MCP: read, file and update tickets, stage docs, and, for an admin, edit the plan and sprints.</p>`
    + `<p class="muted">You can disconnect it any time in Settings.</p>`
    + `<form method="post" action="/oauth/authorize">${inputs}<div class="row">`
    + `<button class="btn" type="submit" name="decision" value="deny">Deny</button>`
    + `<button class="btn primary" type="submit" name="decision" value="allow">Allow</button></div></form>`);
}
