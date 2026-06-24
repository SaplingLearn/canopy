import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { type DB, first, run } from "../db";
import { randomToken, hmacSeal, hmacUnseal } from "./crypto";

const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(db: DB, login: string): Promise<{ id: string; expiresAt: string }> {
  const id = randomToken(32);
  const now = Date.now();
  const created_at = new Date(now).toISOString();
  const expires_at = new Date(now + SESSION_TTL_MS).toISOString();
  await run(db, `INSERT INTO sessions (id, user, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    id, login, created_at, expires_at);
  return { id, expiresAt: expires_at };
}

export async function getSessionUser(db: DB, id: string): Promise<string | null> {
  const row = await first<{ user: string; expires_at: string }>(
    db, `SELECT user, expires_at FROM sessions WHERE id = ?`, id);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.user;
}

export async function deleteSession(db: DB, id: string): Promise<void> {
  await run(db, `DELETE FROM sessions WHERE id = ?`, id);
}

export async function setSessionCookie(c: Context, id: string, secret: string): Promise<void> {
  setCookie(c, SESSION_COOKIE, await hmacSeal(id, secret), {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function readSessionCookie(c: Context, secret: string): Promise<string | null> {
  const sealed = getCookie(c, SESSION_COOKIE);
  return sealed ? hmacUnseal(sealed, secret) : null;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
