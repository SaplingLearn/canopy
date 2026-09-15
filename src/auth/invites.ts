import { type DB, first, all, run, nowIso } from "../db";
import type { InviteRow } from "@shared/rows";
import { findPersonByEmail } from "./persons";

const norm = (e: string) => e.trim().toLowerCase();

export async function findLiveInvite(db: DB, email: string): Promise<InviteRow | null> {
  return first<InviteRow>(db, `SELECT * FROM invites WHERE email = ? AND revoked_at IS NULL AND accepted_by IS NULL`, norm(email));
}

export async function createInvite(db: DB, i: { email: string; name: string | null; invitedBy: string }): Promise<InviteRow> {
  const email = norm(i.email);
  if (await findPersonByEmail(db, email)) throw new Error("already_a_person");
  if (await findLiveInvite(db, email)) throw new Error("invite_exists");
  await run(db,
    `INSERT INTO invites (email, name, invited_by, invited_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, invited_by = excluded.invited_by, invited_at = excluded.invited_at,
       accepted_by = NULL, revoked_at = NULL, email_sent_at = NULL, email_id = NULL, email_error = NULL`,
    email, i.name, i.invitedBy, nowIso());
  return (await first<InviteRow>(db, `SELECT * FROM invites WHERE email = ?`, email))!;
}

export async function acceptInvite(db: DB, email: string, handle: string): Promise<void> {
  await run(db, `UPDATE invites SET accepted_by = ? WHERE email = ? AND accepted_by IS NULL`, handle, norm(email));
}

export async function revokeInvite(db: DB, email: string): Promise<boolean> {
  const row = await first<InviteRow>(db, `SELECT * FROM invites WHERE email = ?`, norm(email));
  if (!row) return false;
  if (!row.revoked_at) await run(db, `UPDATE invites SET revoked_at = ? WHERE email = ?`, nowIso(), row.email);
  return true;
}

export function listInvites(db: DB): Promise<InviteRow[]> {
  return all<InviteRow>(db, `SELECT * FROM invites ORDER BY invited_at DESC, email ASC`);
}

export async function recordInviteEmail(db: DB, email: string, r: { id: string | null; error: string | null }): Promise<void> {
  await run(db, `UPDATE invites SET email_sent_at = ?, email_id = ?, email_error = ? WHERE email = ?`, nowIso(), r.id, r.error, norm(email));
}
