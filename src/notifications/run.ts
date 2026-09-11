// The run assembler (canopy-email.md §4). Per eligible user: resolve every
// registry kind, keep the ones matching the run cadence, claim the outbox row
// FIRST (the idempotency key is the unique constraint — a conflict means this
// window already ran for them), render, drop nulls, then skip or send.
import type { NotificationKind, RunCadence, Section, Window } from "@shared/notifications";
import type { NotificationSettingsRow } from "@shared/rows";
import { type DB, all, first, run, nowIso } from "../db";
import { REGISTRY } from "./registry";
import { loadPolicies, loadPrefs, resolveWith } from "./resolve";
import { computeWindow } from "./window";
import { assembleMessage } from "./assemble";
import type { Delivery } from "./delivery";

export interface RunOptions {
  delivery: Delivery;
  registry?: readonly NotificationKind<DB>[];
  origin?: string; // absolute prefix for deep links
}

export interface RunReport {
  window: Window;
  eligible: number;
  alreadyRan: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface Recipient { github_login: string; email: string; }

const DEFAULT_TZ = "America/New_York";

async function setStatus(db: DB, key: string, patch: { status: string; kinds?: string[]; resend_id?: string | null; error?: string | null; sent_at?: string | null }): Promise<void> {
  await run(
    db,
    `UPDATE notification_outbox SET status = ?, kinds = COALESCE(?, kinds), resend_id = ?, error = ?, sent_at = ? WHERE idempotency_key = ?`,
    patch.status,
    patch.kinds ? JSON.stringify(patch.kinds) : null,
    patch.resend_id ?? null,
    patch.error ?? null,
    patch.sent_at ?? null,
    key
  );
}

export async function runDigest(db: DB, cadence: RunCadence, now: Date, opts: RunOptions): Promise<RunReport> {
  const registry = opts.registry ?? REGISTRY;
  const origin = opts.origin ?? "";
  const settings = await first<NotificationSettingsRow>(db, `SELECT * FROM notification_settings WHERE id = 1`);
  const timeZone = settings?.timezone ?? DEFAULT_TZ;
  const window = computeWindow(cadence, now, timeZone);
  const report: RunReport = { window, eligible: 0, alreadyRan: 0, sent: 0, skipped: 0, failed: 0 };

  const policies = await loadPolicies(db);
  // Eligibility is a hard gate above resolution: an address on file, not unsubscribed.
  const recipients = await all<Recipient>(
    db,
    `SELECT github_login, email FROM users WHERE email IS NOT NULL AND email != '' AND email_unsubscribed = 0 ORDER BY github_login`
  );

  for (const who of recipients) {
    report.eligible++;
    const prefs = await loadPrefs(db, who.github_login);
    const selected = registry.filter((k) => resolveWith(k, policies.get(k.id), prefs.get(k.id)) === cadence);

    const key = `${who.github_login}:${cadence}:${window.id}`;
    const claim = await run(
      db,
      `INSERT OR IGNORE INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      key,
      who.github_login,
      cadence,
      window.id,
      JSON.stringify(selected.map((k) => k.id)),
      nowIso()
    );
    if ((claim.meta.changes ?? 0) === 0) {
      report.alreadyRan++;
      continue;
    }

    const sections: Section[] = [];
    const rendered: string[] = [];
    try {
      for (const k of selected) {
        const s = await k.render(db, who.github_login, window);
        if (s) {
          sections.push(s);
          rendered.push(k.id);
        }
      }
    } catch (e) {
      await setStatus(db, key, { status: "failed", error: `render: ${String((e as Error)?.message ?? e)}` });
      report.failed++;
      continue;
    }

    if (sections.length === 0) {
      await setStatus(db, key, { status: "skipped", kinds: [] });
      report.skipped++;
      continue;
    }

    const msg = assembleMessage({ sections, window, timeZone, origin });
    try {
      const { id } = await opts.delivery.send({ idempotencyKey: key, to: who.email, ...msg });
      await setStatus(db, key, { status: "sent", kinds: rendered, resend_id: id, sent_at: nowIso() });
      report.sent++;
    } catch (e) {
      await setStatus(db, key, { status: "failed", kinds: rendered, error: `send: ${String((e as Error)?.message ?? e)}` });
      report.failed++;
    }
  }
  return report;
}
