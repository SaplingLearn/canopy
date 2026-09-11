// notification_policy seeding (canopy-email.md §2): one row per registry kind,
// inserted only when missing, never overwritten — an admin's change to
// default_cadence / enabled outlives every deploy.
import { type DB, run, nowIso } from "../db";
import { REGISTRY } from "./registry";

export async function seedNotificationPolicy(db: DB): Promise<{ inserted: string[] }> {
  const now = nowIso();
  const inserted: string[] = [];
  for (const k of REGISTRY) {
    const res = await run(
      db,
      `INSERT OR IGNORE INTO notification_policy (kind, default_cadence, enabled, updated_at, updated_by)
       VALUES (?, ?, 1, ?, 'registry')`,
      k.id,
      k.defaultCadence,
      now
    );
    if ((res.meta.changes ?? 0) > 0) inserted.push(k.id);
  }
  return { inserted };
}

// "Runs on startup": a Worker has no boot hook, so this is memoized per isolate
// and awaited from the entry points. One INSERT OR IGNORE per kind per isolate
// lifetime; a failure clears the memo so the next request retries.
let seeded: Promise<void> | null = null;
export function ensureNotificationPolicySeeded(db: DB): Promise<void> {
  if (!seeded) {
    seeded = seedNotificationPolicy(db)
      .then(() => undefined)
      .catch((e) => {
        seeded = null;
        throw e;
      });
  }
  return seeded;
}
