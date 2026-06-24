import { describe, it, expect } from "vitest";
import { sha256Hex, randomToken, pkceChallenge, hmacSeal, hmacUnseal } from "../src/auth/crypto";

describe("auth crypto", () => {
  it("sha256Hex matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("randomToken is url-safe and >= 43 chars for 32 bytes, and unique", () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(b);
  });

  it("pkceChallenge equals base64url(sha256(verifier))", async () => {
    const v = "test-verifier";
    const ch = await pkceChallenge(v);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(ch).toBe(expected);
  });

  it("hmacSeal/hmacUnseal round-trips and rejects tampering and wrong secret", async () => {
    const sealed = await hmacSeal("session-id-123", "secret");
    expect(await hmacUnseal(sealed, "secret")).toBe("session-id-123");
    expect(await hmacUnseal(sealed, "other-secret")).toBeNull();
    expect(await hmacUnseal(sealed + "x", "secret")).toBeNull();
    expect(await hmacUnseal("no-dot", "secret")).toBeNull();
  });
});
