import { type DB, first, run, nowIso } from "../db";
import { randomToken, sha256Hex } from "./crypto";

const TOKEN_PREFIX = "canopy_mcp_";

/** Mint a token: returns the raw token ONCE; stores only its SHA-256 hash. */
export async function mintToken(db: DB, login: string): Promise<{ raw: string }> {
  const raw = TOKEN_PREFIX + randomToken(32);
  const token_hash = await sha256Hex(raw);
  await run(db, `INSERT INTO mcp_tokens (user, token_hash, created_at) VALUES (?, ?, ?)`,
    login, token_hash, nowIso());
  return { raw };
}

/** Resolve a presented raw token to its owner; null if missing/unknown/revoked. Bumps last_used_at. */
export async function resolveToken(db: DB, raw: string): Promise<{ login: string } | null> {
  if (!raw) return null;
  const token_hash = await sha256Hex(raw);
  const row = await first<{ id: number; user: string }>(
    db, `SELECT id, user FROM mcp_tokens WHERE token_hash = ? AND revoked = 0`, token_hash);
  if (!row) return null;
  await run(db, `UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?`, nowIso(), row.id);
  return { login: row.user };
}
