import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, SAPLING_ORG } from "../src/auth/github";

describe("buildAuthorizeUrl", () => {
  it("targets GitHub authorize with client_id, redirect_uri, scope, state, and S256 challenge", () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/auth/callback", state: "st", challenge: "ch" })
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x/auth/callback");
    expect(url.searchParams.get("scope")).toBe("read:org read:user");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("pins the org constant", () => {
    expect(SAPLING_ORG).toBe("SaplingLearn");
  });
});
