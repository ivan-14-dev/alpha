import { all, run, transaction } from '../../db.js';
import { audit, notify, now } from '../../core.js';
import { registerJob } from '../../platform/jobs.js';
import { log } from '../../platform/log.js';
import { fetchCollectionStatus, applyProviderStatus } from '../intents.js';
import { reconcileRefunds } from './refunds.js';
import { backoffMs, getIntent, isoIn, safeReason, type IntentRow } from './store.js';

export const RECONCILE_JOB = 'payments.reconcile';

/** Re-confirms one open intent with the provider; when it is past `expires_at` and still pending, it expires. */
export async function reconcileIntent(intent: IntentRow, source = 'reconcile') {
  if (intent.provider_reference) {
    try {
      const result = await fetchCollectionStatus(intent);
      const updated = applyProviderStatus(intent.id, result, source);
      if (updated.status !== 'created' && updated.status !== 'pending') return updated;
    } catch (error) {
      log.warn('payments.reconcile.status_failed', { intent: intent.id, provider: intent.provider, error: safeReason(error) });
    }
  }
  return transaction(() => {
    const current = getIntent(intent.id)!;
    if (current.status !== 'created' && current.status !== 'pending') return current;
    if (Date.parse(current.expires_at) <= Date.now()) {
      run("UPDATE payment_intents SET status='expired',failure_reason='Paiement non finalisé dans le délai imparti.',next_check_at=NULL,updated_at=? WHERE id=?", now(), current.id);
      notify(current.user_id, 'payment', 'Paiement expiré', 'Le paiement n’a pas été finalisé à temps. Aucun montant n’a été crédité ; vous pouvez réessayer.', `/checkout/return?intent=${current.id}`);
      audit(current.user_id, 'payments.intent.expired', 'payment_intent', current.id, source);
    } else {
      run('UPDATE payment_intents SET attempts=attempts+1,next_check_at=?,last_checked_at=? WHERE id=?',
        isoIn(backoffMs(current.attempts + 1)), now(), current.id);
    }
    return getIntent(current.id)!;
  });
}

/** Job body: due open intents (status re-check with backoff, expiry), then refund retries. */
export async function reconcilePayments(limit = 50) {
  const due = all<IntentRow>(`SELECT * FROM payment_intents WHERE status IN ('created','pending')
    AND (next_check_at IS NULL OR next_check_at<=? OR expires_at<=?) ORDER BY COALESCE(next_check_at,created_at) LIMIT ?`, now(), now(), limit);
  let checked = 0;
  for (const intent of due) {
    await reconcileIntent(intent);
    checked += 1;
  }
  await reconcileRefunds(limit);
  return { checked };
}

registerJob({
  name: RECONCILE_JOB,
  description: 'Paiements : re-vérifie les paiements en attente auprès des prestataires, expire les paiements abandonnés et relance les remboursements.',
  intervalMs: 60_000,
  run: async () => { await reconcilePayments(); },
});
