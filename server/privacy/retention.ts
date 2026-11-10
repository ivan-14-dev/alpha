import type { SQLInputValue } from 'node:sqlite';
import { one, run, transaction } from '../db.js';
import { log } from '../platform/log.js';
import { daysAgo, retentionSettings, type RetentionSettings } from './settings.js';
import { hasColumns } from './schema.js';

/**
 * Storage limitation (Art. 5.1.e). Each category is purged in its own savepoint so that one failure
 * (e.g. a foreign key from another module) never blocks the others. Other modules purge their own
 * tables from their own jobs; the only foreign table handled here is `risk_signals` (trust), if present.
 */
interface Category {
  key: string;
  label: string;
  table: string;
  where: string;
  params: SQLInputValue[];
  /** Exports are closed (status update), everything else is deleted. */
  update?: string;
  cutoff: string | null;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

function categories(settings: RetentionSettings): Category[] {
  const current = new Date().toISOString();
  const prefixes = settings.audit_long_prefixes;
  const longAudit = prefixes.length
    ? `(${prefixes.map(() => "(action=? OR action LIKE ? ESCAPE '\\')").join(' OR ')})`
    : '0';
  const longParams = prefixes.flatMap((prefix) => [prefix, `${escapeLike(prefix)}.%`]);
  const list: Category[] = [
    { key: 'sessions_expired', label: 'Sessions expirées', table: 'sessions', where: 'expires_at<=?', params: [current], cutoff: current },
    { key: 'notifications_read', label: `Notifications lues de plus de ${settings.notifications_read_days} jours`, table: 'notifications',
      where: 'read_at IS NOT NULL AND created_at<?', params: [daysAgo(settings.notifications_read_days)], cutoff: daysAgo(settings.notifications_read_days) },
    { key: 'emails_sent', label: `E-mails envoyés ou journalisés de plus de ${settings.email_sent_days} jours`, table: 'email_outbox',
      where: "status IN ('sent','logged','cancelled') AND created_at<?", params: [daysAgo(settings.email_sent_days)], cutoff: daysAgo(settings.email_sent_days) },
    { key: 'emails_failed', label: `E-mails en échec de plus de ${settings.email_failed_days} jours`, table: 'email_outbox',
      where: "status='failed' AND created_at<?", params: [daysAgo(settings.email_failed_days)], cutoff: daysAgo(settings.email_failed_days) },
    { key: 'rate_limits', label: 'Compteurs anti-abus expirés', table: 'rate_limit_buckets', where: 'reset_at<=?', params: [current], cutoff: current },
    { key: 'audit_standard', label: `Journaux d’audit ordinaires de plus de ${settings.audit_days} jours`, table: 'audit_events',
      where: `created_at<? AND NOT ${longAudit}`, params: [daysAgo(settings.audit_days), ...longParams], cutoff: daysAgo(settings.audit_days) },
    { key: 'audit_long', label: `Journaux d’audit financiers, de confiance et RGPD de plus de ${settings.audit_long_days} jours`, table: 'audit_events',
      where: `created_at<? AND ${longAudit}`, params: [daysAgo(settings.audit_long_days), ...longParams], cutoff: daysAgo(settings.audit_long_days) },
    { key: 'exports_expired', label: 'Liens d’export expirés (clôture)', table: 'privacy_requests',
      where: "kind='export' AND status='ready' AND expires_at<=?", params: [current], update: "status='completed'", cutoff: current },
    { key: 'privacy_requests', label: `Demandes RGPD clôturées depuis plus de ${settings.privacy_requests_days} jours`, table: 'privacy_requests',
      where: "status IN ('completed','cancelled','rejected') AND updated_at<?", params: [daysAgo(settings.privacy_requests_days)], cutoff: daysAgo(settings.privacy_requests_days) },
  ];
  if (hasColumns('risk_signals', 'created_at')) {
    list.push({ key: 'risk_signals', label: `Signaux anti-fraude de plus de ${settings.risk_signals_days} jours`, table: 'risk_signals',
      where: 'created_at<?', params: [daysAgo(settings.risk_signals_days)], cutoff: daysAgo(settings.risk_signals_days) });
  }
  return list;
}

export interface RetentionResult {
  dry_run: boolean;
  ran_at: string;
  categories: { key: string; label: string; count: number; cutoff: string | null; error?: string }[];
  total: number;
}

/** `dryRun` only counts. Real runs delete (or close) matching rows category by category. */
export function runRetention(dryRun: boolean, settings = retentionSettings()): RetentionResult {
  const result: RetentionResult = { dry_run: dryRun, ran_at: new Date().toISOString(), categories: [], total: 0 };
  for (const category of categories(settings)) {
    try {
      const count = dryRun
        ? one<{ total: number }>(`SELECT COUNT(*) AS total FROM ${category.table} WHERE ${category.where}`, ...category.params)!.total
        : transaction(() => Number(run(category.update
          ? `UPDATE ${category.table} SET ${category.update},updated_at=? WHERE ${category.where}`
          : `DELETE FROM ${category.table} WHERE ${category.where}`, ...(category.update ? [result.ran_at] : []), ...category.params).changes));
      result.categories.push({ key: category.key, label: category.label, count, cutoff: category.cutoff });
      result.total += count;
    } catch (error) {
      log.error('privacy.retention_failed', { category: category.key, error });
      result.categories.push({ key: category.key, label: category.label, count: 0, cutoff: category.cutoff,
        error: 'Purge impossible pour cette catégorie (référencée par un autre module ?). Consultez les journaux du serveur.' });
    }
  }
  return result;
}
