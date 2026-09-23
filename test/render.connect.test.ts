/**
 * Settings › "Get connection command" — the pure snippet builder and the modal.
 *
 *  • connectSnippet — each client's exact setup, with the token filled in
 *  • connectModal — closed → nothing; minting → a spinner and no token;
 *    ready → the setup + Copy + where the token now lives; failed → the error;
 *    the pressed tab is inert (no data-act)
 */
import { describe, it, expect } from "vitest";
import { connectSnippet, connectModal, tokenLabel } from "../web/src/render";

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
    expect(html).toContain("MCP access tokens");
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
