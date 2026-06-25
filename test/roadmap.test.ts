import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { encryptSecret, decryptSecret } from "../src/auth/crypto";
import { storeToken, getStoredToken } from "../src/auth/github";
import { run, nowIso } from "../src/db";

const SECRET = "test-cookie-secret";

describe("AES-GCM secret sealing", () => {
  it("round-trips a value and fails closed on a wrong secret / garbage", async () => {
    const sealed = await encryptSecret("gho_secret_token", SECRET);
    expect(sealed).not.toContain("gho_secret_token");
    expect(await decryptSecret(sealed, SECRET)).toBe("gho_secret_token");
    expect(await decryptSecret(sealed, "wrong-secret")).toBeNull();
    expect(await decryptSecret("not-valid", SECRET)).toBeNull();
  });
});

describe("GitHub token retention", () => {
  it("stores a sealed token and reads it back for the principal; null when absent", async () => {
    await run(env.DB, `INSERT INTO users (github_login, name, created_at) VALUES (?, ?, ?)`, "andres", null, nowIso());
    expect(await getStoredToken(env.DB, "andres", SECRET)).toBeNull();

    await storeToken(env.DB, "andres", "gho_live_token", SECRET);
    expect(await getStoredToken(env.DB, "andres", SECRET)).toBe("gho_live_token");
    expect(await getStoredToken(env.DB, "nobody", SECRET)).toBeNull();
  });
});
