// The run assembler (canopy-email.md §4). Per eligible user: resolve every
// registry kind, keep the ones matching the run cadence, claim the outbox row
// FIRST (the idempotency key is the unique constraint — a conflict means this
// window already ran for them), render, drop nulls, then skip or send.
import type { NotificationKind, RunCadence, Section, Window } from "@shared/notifications";
import { type DB, all, run, nowIso } from "../db";
import { REGISTRY } from "./registry";
import { loadPolicies, loadPrefs, resolveWith } from "./resolve";
import { computeWindow } from "./window";
import { assembleMessage } from "./assemble";
import type { Delivery } from "./delivery";
import { loadSettings } from "./cron";

export interface DeliverOptions {
  delivery: Delivery;
  origin?: string; // absolute prefix for deep links
  /** The https one-click unsubscribe target for a login; defaults to the Settings deep link. */
  unsubscribeUrl?: (login: string) => Promise<string>;
}

export interface RunOptions extends DeliverOptions {
  registry?: readonly NotificationKind<DB>[];
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

export interface ClaimedRow {
  key: string;
  login: string;
  email: string;
  kinds: readonly NotificationKind<DB>[];
  window: Window;
  timeZone: string;
}

/** Render every kind for a login/window and drop nulls. Pure read; throws on a renderer error. */
export async function renderSections(db: DB, login: string, kinds: readonly NotificationKind<DB>[], window: Window): Promise<{ sections: Section[]; rendered: string[] }> {
  const sections: Section[] = [];
  const rendered: string[] = [];
  for (const k of kinds) {
    const s = await k.render(db, login, window);
    if (s) {
      sections.push(s);
      rendered.push(k.id);
    }
  }
  return { sections, rendered };
}

/** Assemble the one message for a login from already-rendered sections. */
export async function buildMessage(sections: Section[], row: Pick<ClaimedRow, "login" | "window" | "timeZone">, opts: DeliverOptions) {
  const origin = opts.origin ?? "";
  const unsubscribeUrl = opts.unsubscribeUrl ? await opts.unsubscribeUrl(row.login) : `${origin}/#settings`;
  return { unsubscribeUrl, ...assembleMessage({ sections, window: row.window, timeZone: row.timeZone, origin, login: row.login, unsubscribeUrl }) };
}

/**
 * Render the claimed kinds for one outbox row, drop nulls, then skip or send,
 * recording the outcome on the row. Shared by the run, the retry job and the
 * admin test send. `presetSections` skips rendering (the sample preview).
 */
export async function deliverRow(db: DB, row: ClaimedRow, opts: DeliverOptions, presetSections?: Section[]): Promise<"sent" | "skipped" | "failed"> {
  let sections: Section[];
  let rendered: string[];
  try {
    if (presetSections) {
      sections = presetSections;
      rendered = row.kinds.map((k) => k.id);
    } else {
      ({ sections, rendered } = await renderSections(db, row.login, row.kinds, row.window));
    }
  } catch (e) {
    await setStatus(db, row.key, { status: "failed", error: `render: ${String((e as Error)?.message ?? e)}` });
    return "failed";
  }

  if (sections.length === 0) {
    await setStatus(db, row.key, { status: "skipped", kinds: [] });
    return "skipped";
  }

  const { unsubscribeUrl, ...msg } = await buildMessage(sections, row, opts);
  try {
    const { id } = await opts.delivery.send({ idempotencyKey: row.key, userId: row.login, to: row.email, unsubscribeUrl, ...msg });
    await setStatus(db, row.key, { status: "sent", kinds: rendered, resend_id: id, sent_at: nowIso() });
    return "sent";
  } catch (e) {
    await setStatus(db, row.key, { status: "failed", kinds: rendered, error: `send: ${String((e as Error)?.message ?? e)}` });
    return "failed";
  }
}

export async function runDigest(db: DB, cadence: RunCadence, now: Date, opts: RunOptions): Promise<RunReport> {
  const registry = opts.registry ?? REGISTRY;
  const settings = await loadSettings(db);
  const timeZone = settings.timezone;
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

    const outcome = await deliverRow(db, { key, login: who.github_login, email: who.email, kinds: selected, window, timeZone }, opts);
    report[outcome]++;
  }
  return report;
}
