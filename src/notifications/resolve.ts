// Cadence resolution (canopy-email.md §3). Three layers, first match wins:
// user pref → policy default_cadence → registry default. Absence inherits.
// Admin authority is existence only: policy.enabled = 0 is 'off' for everyone
// and the user layer is never consulted.
import type { Cadence, NotificationKindMeta } from "@shared/notifications";
import type { NotificationPolicyRow, NotificationPrefRow } from "@shared/rows";
import { type DB, all, first } from "../db";
import { getKind } from "./registry";

export type PolicyMap = Map<string, NotificationPolicyRow>;
export type PrefMap = Map<string, Cadence>;

export async function loadPolicies(db: DB): Promise<PolicyMap> {
  const rows = await all<NotificationPolicyRow>(db, `SELECT * FROM notification_policy`);
  return new Map(rows.map((r) => [r.kind, r]));
}

export async function loadPrefs(db: DB, userId: string): Promise<PrefMap> {
  const rows = await all<NotificationPrefRow>(db, `SELECT * FROM notification_prefs WHERE user_id = ?`, userId);
  return new Map(rows.map((r) => [r.kind, r.cadence]));
}

/** Pure resolution over preloaded layers — the run assembler's hot path. */
export function resolveWith(kind: NotificationKindMeta, policy: NotificationPolicyRow | undefined, pref: Cadence | undefined): Cadence {
  if (policy && policy.enabled === 0) return "off";
  if (pref !== undefined) return pref;
  if (policy) return policy.default_cadence;
  return kind.defaultCadence;
}

/** resolveCadence(userId, kind): one user, one kind. Unknown kind → 'off'. */
export async function resolveCadence(db: DB, userId: string, kindId: string): Promise<Cadence> {
  const kind = getKind(kindId);
  if (!kind) return "off";
  const policy = (await first<NotificationPolicyRow>(db, `SELECT * FROM notification_policy WHERE kind = ?`, kindId)) ?? undefined;
  if (policy && policy.enabled === 0) return "off";
  const pref = await first<NotificationPrefRow>(db, `SELECT * FROM notification_prefs WHERE user_id = ? AND kind = ?`, userId, kindId);
  return resolveWith(kind, policy, pref?.cadence);
}
