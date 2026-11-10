import { all } from '../db.js';
import { registerJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { registerPersonalData } from '../platform/privacy.js';
import { consentHistory, consentsFor, withdrawAllConsents } from './consents.js';
import { processDueErasures } from './erasure.js';
import { processPendingExports } from './requests.js';
import { runRetention } from './retention.js';
import { retentionSettings } from './settings.js';

let registered = false;

/** Registers the privacy jobs and the module's own personal data handler. Idempotent (called at import of the router). */
export function registerPrivacyModule() {
  if (registered) return;
  registered = true;

  registerJob({
    name: 'privacy.erasure',
    description: 'Exécute les suppressions de compte arrivées au terme du délai de rétractation de 30 jours.',
    intervalMs: 3600000,
    run: () => {
      const summary = processDueErasures();
      if (summary.completed || summary.blocked) log.info('privacy.erasure_run', summary);
    },
  });

  registerJob({
    name: 'privacy.exports',
    description: 'Prépare les exports de données en attente et clôture les liens de téléchargement expirés.',
    intervalMs: 5 * 60000,
    run: () => {
      const summary = processPendingExports();
      if (summary.failed) throw new Error(`${summary.failed} export(s) n’ont pas pu être préparés.`);
    },
  });

  registerJob({
    name: 'privacy.retention',
    description: 'Purge les données arrivées au terme de leur durée de conservation (sessions, notifications, e-mails, journaux).',
    intervalMs: 24 * 3600000,
    enabled: () => retentionSettings().enabled,
    run: () => {
      const result = runRetention(false);
      log.info('privacy.retention_run', { total: result.total, categories: Object.fromEntries(result.categories.map((category) => [category.key, category.count])) });
      const failed = result.categories.filter((category) => category.error);
      if (failed.length) throw new Error(`Purge incomplète : ${failed.map((category) => category.key).join(', ')}.`);
    },
  });

  registerPersonalData('privacy', {
    description: 'Consentements (état et historique) et demandes RGPD (exports, suppressions).',
    export: (userId) => ({
      consents: consentsFor(userId),
      consent_history: consentHistory(userId, 1000),
      requests: all(`SELECT id,kind,status,reason,requested_at,scheduled_for,processed_at,expires_at,downloaded_at,download_count,rejection_reason
        FROM privacy_requests WHERE user_id=? ORDER BY requested_at DESC`, userId),
    }),
    // Requests and consent history are accountability evidence (Art. 5.2/7.1) and stay linked to the anonymized id.
    erase: (userId) => { withdrawAllConsents(userId); },
  });
}
