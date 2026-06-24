import { describe, it, expect } from "vitest";
import { authApp } from "../src/auth/routes";
import { env } from "cloudflare:test";

describe("GET /auth/login", () => {
  it("302-redirects to GitHub authorize with PKCE params and sets the oauth_tx cookie", async () => {
    const res = await authApp.request("/login", {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain("oauth_tx=");
  });
});
