// The retry job (canopy-email.md §4): re-attempts `failed` outbox rows ONLY.
// A row is re-rendered for its original window (recomputed from the cadence
// and the row's created_at) over the kinds it was claimed with, then sent;
// sent / skipped / pending rows are never touched. Bounded to rows younger
// than RETRY_MAX_AGE so a permanently failing row does not retry forever.
import type { NotificationOutboxRow } from "@shared/rows";
import { type DB, all, first } from "../db";
import { getKind } from "./registry";
import { computeWindow } from "./window";
import { deliverRow, type DeliverOptions } from "./run";
import { loadSettings } from "./cron";

const RETRY_LIMIT = 20;
const RETRY_MAX_AGE_HOURS = 48;

export interface RetryReport { retried: number; sent: number; skipped: number; failed: number; }

interface Recipient { github_login: string; email: string | null; email_unsubscribed: number; }

export async function retryFailed(db: DB, opts: DeliverOptions): Promise<RetryReport> {
  const report: RetryReport = { retried: 0, sent: 0, skipped: 0, failed: 0 };
  const settings = await loadSettings(db);
  const rows = await all<NotificationOutboxRow>(
    db,
    `SELECT * FROM notification_outbox
      WHERE status = 'failed' AND datetime(created_at) >= datetime('now', ?)
      ORDER BY created_at DESC LIMIT ${RETRY_LIMIT}`,
    `-${RETRY_MAX_AGE_HOURS} hours`
  );
  for (const row of rows) {
    // Eligibility is re-checked: an unsubscribe or a cleared address since the
    // original run is a hard gate here too.
    const who = await first<Recipient>(db, `SELECT handle AS github_login, email, email_unsubscribed FROM persons WHERE handle = ?`, row.user_id);
    if (!who || !who.email || who.email_unsubscribed !== 0) continue;
    report.retried++;
    const window = computeWindow(row.cadence, new Date(row.created_at), settings.timezone);
    const kinds = (JSON.parse(row.kinds) as string[]).map(getKind).filter((k): k is NonNullable<typeof k> => !!k);
    const outcome = await deliverRow(db, { key: row.idempotency_key, login: who.github_login, email: who.email, kinds, window, timeZone: settings.timezone }, opts);
    report[outcome]++;
  }
  return report;
}
