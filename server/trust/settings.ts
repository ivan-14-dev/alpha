import { z } from 'zod';
import { getSetting } from '../platform/settings.js';

/** Admin-tunable thresholds of the anti-abuse detectors (platform setting `trust.thresholds`). */
export const THRESHOLDS_SETTING = 'trust.thresholds';
export const AUTO_ACTIONS_SETTING = 'trust.auto_actions';
export const RETENTION_SETTING = 'trust.retention';
export const APPEALS_SETTING = 'trust.appeals';
/** Owned by the privacy module: single source of truth for the risk signal retention. */
export const PRIVACY_RETENTION_SETTING = 'privacy.retention';

const int = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).default(fallback);

export const thresholdsSchema = z.object({
  window_days: int(1, 365, 30),
  multi_account_device_users: int(2, 50, 2),
  ip_registrations_per_day: int(2, 500, 5),
  collusion_window_days: int(7, 365, 90),
  collusion_repeat_payouts: int(2, 100, 3),
  review_window_days: int(7, 365, 90),
  review_burst_count: int(2, 100, 5),
  review_burst_hours: int(1, 168, 24),
  new_account_days: int(1, 90, 7),
  failed_logins_per_hour: int(3, 1000, 10),
  payment_failures_per_day: int(2, 1000, 5),
  withdrawal_after_funding_hours: int(1, 720, 24),
  dismissed_cooldown_days: int(0, 365, 30),
}).strict();
export type Thresholds = z.infer<typeof thresholdsSchema>;
export const defaultThresholds: Thresholds = thresholdsSchema.parse({});
export const thresholds = (): Thresholds => getSetting(THRESHOLDS_SETTING, thresholdsSchema, defaultThresholds);

/** Automatic measures are conservative: only withdrawals can be held, never an automatic ban. */
export const autoActionsSchema = z.object({
  hold_withdrawals_on_high_risk: z.boolean().default(false),
  hold_days: int(1, 90, 14),
}).strict();
export type AutoActions = z.infer<typeof autoActionsSchema>;
export const defaultAutoActions: AutoActions = autoActionsSchema.parse({});
export const autoActions = (): AutoActions => getSetting(AUTO_ACTIONS_SETTING, autoActionsSchema, defaultAutoActions);

export const retentionSchema = z.object({
  dismissed_cases_days: int(30, 3650, 365),
  sanctions_years: int(1, 10, 5),
}).strict();
export type TrustRetention = z.infer<typeof retentionSchema>;
export const defaultRetention: TrustRetention = retentionSchema.parse({});
export const trustRetention = (): TrustRetention => getSetting(RETENTION_SETTING, retentionSchema, defaultRetention);

const privacyRetentionSchema = z.object({ risk_signals_days: z.number().int().min(30).max(3650) }).passthrough();
export function signalRetentionDays(): number {
  return getSetting(PRIVACY_RETENTION_SETTING, privacyRetentionSchema, { risk_signals_days: 180 }).risk_signals_days;
}

/** DSA art. 20: appeals stay open at least six months after the decision. */
export const appealsSchema = z.object({
  sla_days: int(1, 60, 7),
  window_days: int(180, 730, 180),
}).strict();
/** Hard limit, also enforced by the `appeals_per_sanction_limit` trigger. */
export const MAX_APPEALS_PER_SANCTION = 2;
export type AppealSettings = z.infer<typeof appealsSchema>;
export const defaultAppeals: AppealSettings = appealsSchema.parse({});
export const appealSettings = (): AppealSettings => getSetting(APPEALS_SETTING, appealsSchema, defaultAppeals);

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
export const isoAgo = (ms: number, from = Date.now()) => new Date(from - ms).toISOString();
