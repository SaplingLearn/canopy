import { type DB, run, nowIso } from "../db";

/**
 * Upsert the teammate row at login. name/avatar_url refresh every time; the
 * email is written ONLY when the row has none yet (first login, or a later
 * login after an earlier one found no address) — a user- or admin-edited
 * address is never overwritten (canopy-email.md §7).
 */
export async function recordLogin(
  db: DB,
  gh: { login: string; name: string | null; avatar_url: string | null },
  email: string | null
): Promise<void> {
  await run(
    db,
    `INSERT INTO users (github_login, name, avatar_url, email, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(github_login) DO UPDATE SET
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       email = COALESCE(users.email, excluded.email)`,
    gh.login,
    gh.name,
    gh.avatar_url,
    email,
    nowIso()
  );
}
