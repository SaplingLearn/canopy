/**
 * Settings › "Get connection command" — the pure snippet builder and the modal.
 *
 *  • connectSnippet — each client's exact setup, with the token filled in
 *  • connectModal — closed → nothing; minting → a spinner and no token;
 *    ready → the setup + Copy + where the token now lives; failed → the error;
 *    the pressed tab is inert (no data-act)
 */
import { describe, it, expect } from "vitest";
import { connectSnippet, connectModal, tokenLabel, grantListBody, browserConnectCommand, render, initialState } from "../web/src/render";

const URL = "https://canopy.example.com/mcp";
const TOKEN = "canopy_mcp_abcd1234";

describe("connectSnippet", () => {
  it("Claude Code: a user-scoped http server with the token as a bearer header", () => {
    const s = connectSnippet("claude", TOKEN, URL);
    expect(s).toContain(`claude mcp add --transport http --scope user canopy ${URL}`);
    expect(s).toContain(`--header "Authorization: Bearer ${TOKEN}"`);
  });

  it("Codex: the token in CANOPY_MCP_TOKEN, read through --bearer-token-env-var", () => {
    const s = connectSnippet("codex", TOKEN, URL);
    expect(s.split("\n")).toEqual([
      `export CANOPY_MCP_TOKEN=${TOKEN}`,
      `codex mcp add canopy --url ${URL} --bearer-token-env-var CANOPY_MCP_TOKEN`,
    ]);
  });

  it("Token only: the bare token", () => {
    expect(connectSnippet("token", TOKEN, URL)).toBe(TOKEN);
  });

  it(".mcp.json: valid JSON carrying the url and the bearer header", () => {
    const cfg = JSON.parse(connectSnippet("json", TOKEN, URL));
    expect(cfg.mcpServers.canopy).toEqual({ type: "http", url: URL, headers: { Authorization: `Bearer ${TOKEN}` } });
  });
});

describe("connectModal", () => {
  const base = { connectClient: "claude" as const, connectCopied: false };

  it("renders nothing while closed", () => {
    expect(connectModal({ ...base, connect: null })).toBe("");
  });

  it("while minting: a dialog with no token, no Copy and no Done", () => {
    const html = connectModal({ ...base, connect: { token: null, error: null } });
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Creating a token");
    expect(html).not.toContain('data-act="connectCopy"');
    expect(html).not.toContain(">Done<");
  });

  it("once minted: the setup with the token, Copy, Done, and where the token lives in Settings", () => {
    const html = connectModal({ ...base, connectClient: "codex", connect: { token: TOKEN, error: null } });
    expect(html).toContain(`export CANOPY_MCP_TOKEN=${TOKEN}`);
    expect(html).toContain('data-act="connectCopy"');
    expect(html).toContain(">Done<");
    expect(html).toContain("Access tokens</strong> under MCP access in Settings");
    expect(html).toContain(tokenLabel(TOKEN));
    expect(html).toContain("only time the token is shown");
  });

  it("a failed mint says so and offers only Close", () => {
    const html = connectModal({ ...base, connect: { token: null, error: "boom" } });
    expect(html).toContain("boom");
    expect(html).not.toContain('data-act="connectCopy"');
  });

  it("the pressed tab carries no data-act; the others switch client", () => {
    const html = connectModal({ ...base, connectClient: "json", connect: { token: TOKEN, error: null } });
    expect(html).not.toContain('data-arg="json"');
    for (const id of ["claude", "codex", "token"]) expect(html).toContain(`data-act="connectClient" data-arg="${id}"`);
  });
});

describe("tokenLabel", () => {
  it("is the row Settings lists: canopy_mcp_ + the first 4 characters", () => {
    expect(tokenLabel(TOKEN)).toBe("canopy_mcp_abcd");
  });
});

describe("browserConnectCommand", () => {
  it("adds the server with no header — Claude Code signs in through the browser", () => {
    expect(browserConnectCommand(URL)).toBe(`claude mcp add --transport http --scope user canopy ${URL}`);
  });
});

describe("Get Started guide — Connect your agent", () => {
  const guideState = () => ({
    ...initialState(),
    view: "app" as const,
    screen: "guide" as const,
    me: { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], org: "SaplingLearn", admin: false },
  });

  it("points at Sign in with browser, not the retired MCP access tokens heading", () => {
    const html = render(guideState());
    expect(html).toContain("Sign in with browser");
    expect(html).not.toContain("MCP access tokens");
  });

  it("never tells the plugin to read CANOPY_MCP_TOKEN — it connects by browser sign-in", () => {
    const html = render(guideState());
    // The variable may be named for token-based clients (Codex, CI) in troubleshooting,
    // but the setup never asks anyone to export it.
    expect(html).not.toContain("export CANOPY_MCP_TOKEN");
    expect(html).not.toContain("set -Ux CANOPY_MCP_TOKEN");
    expect(html).toContain("Authenticate");
  });
});

describe("grantListBody", () => {
  const grant = { id: 7, client_name: "Claude <Code>", created_at: "2026-09-20T00:00:00.000Z", last_used_at: null };
  it("empty, loading and error states", () => {
    expect(grantListBody({ grants: { status: "ok", data: [] }, grantRevokeArm: null })).toContain("No apps connected");
    expect(grantListBody({ grants: { status: "loading", data: [] }, grantRevokeArm: null })).toContain("Loading");
    expect(grantListBody({ grants: { status: "error", data: [], error: "boom" }, grantRevokeArm: null })).toContain("boom");
  });
  it("one escaped row per grant with a two-click revoke", () => {
    const idle = grantListBody({ grants: { status: "ok", data: [grant] }, grantRevokeArm: null });
    expect(idle).toContain("Claude &lt;Code&gt;");
    expect(idle).toContain("never used");
    expect(idle).toContain(`data-act="revokeGrantArm" data-arg="7"`);
    const armed = grantListBody({ grants: { status: "ok", data: [grant] }, grantRevokeArm: 7 });
    expect(armed).toContain(`data-act="revokeGrant" data-arg="7"`);
    expect(armed).toContain(`data-act="revokeGrantCancel"`);
  });
});
