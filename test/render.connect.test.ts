/**
 * Settings › Connect an agent — the pure snippet builder and the tile.
 *
 *  • connectSnippet — each client's exact setup, with the token filled in
 *  • connectAgentSection — a placeholder + "Mint" until a token is revealed,
 *    then the real token + Copy; the pressed tab is inert (no data-act)
 */
import { describe, it, expect } from "vitest";
import { connectSnippet, connectAgentSection, TOKEN_PLACEHOLDER } from "../web/src/render";

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

  it(".mcp.json: valid JSON carrying the url and the bearer header", () => {
    const cfg = JSON.parse(connectSnippet("json", TOKEN, URL));
    expect(cfg.mcpServers.canopy).toEqual({ type: "http", url: URL, headers: { Authorization: `Bearer ${TOKEN}` } });
  });
});

describe("connectAgentSection", () => {
  it("before a mint: the placeholder, and the button mints instead of copying", () => {
    const html = connectAgentSection({ connectClient: "claude", connectCopied: false, revealedToken: null });
    expect(html).toContain(TOKEN_PLACEHOLDER);
    expect(html).toContain('data-act="mintToken"');
    expect(html).not.toContain('data-act="copyConnect"');
  });

  it("after a mint: the real token is filled in and Copy is offered", () => {
    const html = connectAgentSection({ connectClient: "codex", connectCopied: false, revealedToken: TOKEN });
    expect(html).toContain(`export CANOPY_MCP_TOKEN=${TOKEN}`);
    expect(html).toContain('data-act="copyConnect"');
    expect(html).not.toContain(TOKEN_PLACEHOLDER);
  });

  it("the pressed tab carries no data-act; the others switch client", () => {
    const html = connectAgentSection({ connectClient: "json", connectCopied: false, revealedToken: null });
    expect(html).not.toContain('data-arg="json"');
    expect(html).toContain('data-act="connectClient" data-arg="claude"');
    expect(html).toContain('data-act="connectClient" data-arg="codex"');
  });
});
