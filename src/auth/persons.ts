import { type DB, first, all, run, nowIso } from "../db";
import { PERSON_COLORS, type PersonColor, type PersonRow, type IdentityRow, type IdentityProvider } from "@shared/rows";

export const HANDLE_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const RESERVED_HANDLES: readonly string[] = ["github-webhook", "system", "admin", "canopy", "me"];
export type HandleProblem = "invalid" | "reserved" | "taken";

export class HandleTakenError extends Error {
  constructor(handle: string) { super(`handle taken: ${handle}`); }
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}

/** Stable color for a migrated/derived person: FNV-1a over the seed, mod the palette. */
export function defaultColor(seed: string): PersonColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

export function getPerson(db: DB, handle: string): Promise<PersonRow | null> {
  return first<PersonRow>(db, `SELECT * FROM persons WHERE handle = ? COLLATE NOCASE`, handle);
}

export function findIdentity(db: DB, provider: IdentityProvider, subject: string): Promise<IdentityRow | null> {
  return first<IdentityRow>(db, `SELECT * FROM identities WHERE provider = ? AND subject = ?`, provider, subject);
}

export function findPersonByEmail(db: DB, email: string): Promise<PersonRow | null> {
  return first<PersonRow>(db, `SELECT * FROM persons WHERE lower(email) = lower(?)`, email);
}

export async function handleAvailable(db: DB, handle: string): Promise<{ available: boolean; reason?: HandleProblem }> {
  if (!isValidHandle(handle)) return { available: false, reason: "invalid" };
  if (RESERVED_HANDLES.includes(handle)) return { available: false, reason: "reserved" };
  if (await getPerson(db, handle)) return { available: false, reason: "taken" };
  return { available: true };
}

/** Every sign-in: refresh name/avatar; write email ONLY when the row has none (0021 rule). */
export async function recordSignIn(db: DB, handle: string, p: { name: string | null; avatar_url: string | null; email: string | null }): Promise<void> {
  await run(db, `UPDATE persons SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url), email = COALESCE(email, ?) WHERE handle = ? COLLATE NOCASE`,
    p.name, p.avatar_url, p.email, handle);
}

export async function createPerson(db: DB, p: { handle: string; name: string | null; color: PersonColor; avatar_url: string | null; email: string | null }): Promise<PersonRow> {
  const now = nowIso();
  try {
    await run(db, `INSERT INTO persons (handle, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      p.handle, p.name, p.color, p.avatar_url, p.email, now, now);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e))) throw new HandleTakenError(p.handle);
    throw e;
  }
  return (await getPerson(db, p.handle))!;
}

export async function linkIdentity(db: DB, i: { provider: IdentityProvider; subject: string; label: string; person: string; linkedBy: string }): Promise<void> {
  await run(db, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?)`,
    i.provider, i.subject, i.label, i.person, nowIso(), i.linkedBy);
}

export async function unlinkIdentity(db: DB, person: string, provider: IdentityProvider): Promise<"ok" | "last_identity" | "not_found"> {
  const mine = await listIdentities(db, person);
  const target = mine.find((i) => i.provider === provider);
  if (!target) return "not_found";
  if (mine.length <= 1) return "last_identity";
  await run(db, `DELETE FROM identities WHERE provider = ? AND subject = ?`, target.provider, target.subject);
  return "ok";
}

export function listIdentities(db: DB, person: string): Promise<IdentityRow[]> {
  return all<IdentityRow>(db, `SELECT * FROM identities WHERE person = ? COLLATE NOCASE ORDER BY linked_at ASC`, person);
}

export async function updateProfile(db: DB, handle: string, patch: { name?: string | null; color?: PersonColor }): Promise<PersonRow | null> {
  const row = await getPerson(db, handle);
  if (!row) return null;
  await run(db, `UPDATE persons SET name = ?, color = ? WHERE handle = ? COLLATE NOCASE`,
    patch.name === undefined ? row.name : patch.name, patch.color ?? row.color, handle);
  return getPerson(db, handle);
}

export function listPersons(db: DB): Promise<Pick<PersonRow, "handle" | "name" | "color" | "avatar_url">[]> {
  return all(db, `SELECT handle, name, color, avatar_url FROM persons ORDER BY handle COLLATE NOCASE ASC`);
}
