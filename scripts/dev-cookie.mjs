// Forge the signed `session` cookie for local dev, so the cookie-gated routes can be
// exercised over `wrangler dev` without the real GitHub OAuth flow. Reproduces
// src/auth/crypto.ts:hmacSeal exactly: value.base64url(HMAC-SHA256(value, COOKIE_SECRET)).
//
//   usage: node scripts/dev-cookie.mjs [sessionId]   (default: devsession, matching seed-dev.sql)
//   prints: session=<id>.<sig>
import { readFileSync } from "node:fs";

const SESSION_ID = process.argv[2] ?? "devsession";

const devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const line = devVars.split("\n").find((l) => l.startsWith("COOKIE_SECRET="));
if (!line) throw new Error("COOKIE_SECRET not found in .dev.vars");
const secret = line.slice("COOKIE_SECRET=".length).trim().replace(/^["']|["']$/g, "");

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(SESSION_ID));
process.stdout.write(`session=${SESSION_ID}.${b64url(sig)}\n`);
