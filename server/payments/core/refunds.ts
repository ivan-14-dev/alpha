import { all, one, run, transaction } from '../../db.js';
import { audit, id, notify, now } from '../../core.js';
import { afterCommit } from '../../platform/events.js';
import { log } from '../../platform/log.js';
import { providerContext, readProviderConfig } from '../config.js';
import { getProvider } from '../providers/index.js';
import type { StatusResult } from '../providers/types.js';
import { alertAdmins, backoffMs, formatMoney, getIntent, getRefund, isoIn, safeReason, type IntentRow, type RefundRow } from './store.js';

export const MAX_REFUND_ATTEMPTS = 5;

/**
 * Records a provider refund for (part of) a collected intent. Call INSIDE the caller's transaction: the provider
 * call runs after COMMIT and is retried by `payments.reconcile`.
 */
export function createRefund(input: {
  intent: IntentRow;
  amountBaseMinor: number;
  reason: string;
  requestedBy: string | null;
  orderId?: string | null;
  campaignId?: string | null;
  journalId?: string | null;
}): string {
  const { intent } = input;
  // Proportional to what was collected, rounded down so a partial refund never exceeds the original payment.
  const amountMinor = input.amountBaseMinor >= intent.amount_base_minor
    ? intent.amount_minor
    : Math.floor((intent.amount_minor * input.amountBaseMinor) / intent.amount_base_minor);
  const refundId = id();
  run(`INSERT INTO refunds (id,intent_id,order_id,campaign_id,journal_id,mode,provider,amount_base_minor,base_currency,amount_minor,currency,reason,requested_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, refundId, intent.id, input.orderId ?? null, input.campaignId ?? null, input.journalId ?? null,
  intent.mode, intent.provider, input.amountBaseMinor, intent.base_currency, Math.max(1, amountMinor), intent.currency,
  input.reason.slice(0, 1000), input.requestedBy);
  afterCommit(() => processRefund(refundId).then(() => undefined));
  return refundId;
}

function refundPayer(refund: RefundRow) {
  return getIntent(refund.intent_id)?.user_id ?? null;
}

function finishRefund(refund: RefundRow, status: RefundRow['status'], fields: { providerReference?: string | null; error?: string }) {
  transaction(() => {
    const current = getRefund(refund.id)!;
    if (current.status === 'succeeded') return;
    const retry = status === 'pending' && current.attempts < MAX_REFUND_ATTEMPTS;
    const finalStatus = status === 'pending' && !retry ? 'failed' : status;
    run(`UPDATE refunds SET status=?,provider_reference=COALESCE(?,provider_reference),last_error=?,next_attempt_at=?,updated_at=? WHERE id=?`,
      finalStatus, fields.providerReference ?? null, fields.error ?? '', retry ? isoIn(backoffMs(current.attempts)) : null, now(), refund.id);
    const payer = refundPayer(refund);
    const actor = refund.requested_by ?? payer;
    if (finalStatus === 'succeeded') {
      if (payer) notify(payer, 'payment', 'Remboursement effectué', `${formatMoney(refund.amount_minor, refund.currency)} remboursés via votre moyen de paiement.`, '/payments');
      if (actor) audit(actor, 'payments.refund.succeeded', 'refund', refund.id, refund.provider);
    } else if (finalStatus === 'failed') {
      alertAdmins('Remboursement en échec', `Le remboursement ${refund.id} (${formatMoney(refund.amount_minor, refund.currency)}, ${refund.provider}) nécessite une action manuelle : ${fields.error ?? ''}`);
      if (actor) audit(actor, 'payments.refund.failed', 'refund', refund.id, fields.error ?? '');
    }
  });
}

/** Calls the provider for a pending refund. Safe to call concurrently: a refund is claimed before the provider call. */
export async function processRefund(refundId: string): Promise<RefundRow | undefined> {
  const claimed = transaction(() => {
    const refund = getRefund(refundId);
    if (!refund || refund.status !== 'pending') return null;
    run("UPDATE refunds SET status='processing',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'", now(), refundId);
    return getRefund(refundId)!;
  });
  if (!claimed) return getRefund(refundId);
  const intent = getIntent(claimed.intent_id)!;
  const provider = getProvider(claimed.provider);
  if (!provider?.refund || !provider.capabilities.refund) {
    finishRefund(claimed, 'failed', { error: 'Remboursement automatique non pris en charge par ce prestataire : effectuez-le manuellement.' });
    return getRefund(refundId);
  }
  const config = readProviderConfig(provider.id, claimed.mode);
  if (!config || !intent.provider_reference) {
    finishRefund(claimed, 'pending', { error: config ? 'Référence prestataire manquante.' : 'Prestataire désactivé pour cet environnement.' });
    return getRefund(refundId);
  }
  try {
    const result = await provider.refund(config, {
      reference: claimed.id,
      providerReference: intent.provider_reference,
      amountMinor: claimed.amount_minor,
      currency: claimed.currency,
      reason: claimed.reason.slice(0, 200) || 'Remboursement Alpha',
    }, providerContext(provider.id));
    if (result.status === 'succeeded') finishRefund(claimed, 'succeeded', { providerReference: result.providerReference });
    else if (result.status === 'pending') {
      run("UPDATE refunds SET provider_reference=?,next_attempt_at=?,updated_at=? WHERE id=?", result.providerReference, isoIn(backoffMs(0)), now(), claimed.id);
    } else finishRefund(claimed, 'pending', { providerReference: result.providerReference, error: safeReason(result.failureReason, 'Refus du prestataire.') });
  } catch (error) {
    log.warn('payments.refund.failed', { refund: claimed.id, provider: claimed.provider, error: safeReason(error) });
    finishRefund(claimed, 'pending', { error: safeReason(error, 'Erreur du prestataire.') });
  }
  return getRefund(refundId);
}

/** Applies a provider status (webhook or reconciliation) to a refund in `processing`. */
export function applyRefundStatus(refundId: string, result: StatusResult) {
  const refund = getRefund(refundId);
  if (!refund || refund.status !== 'processing') return;
  if (result.status === 'succeeded') finishRefund(refund, 'succeeded', { providerReference: result.providerReference });
  else if (result.status === 'failed' || result.status === 'cancelled') {
    finishRefund(refund, 'pending', { error: safeReason(result.failureReason, 'Remboursement refusé par le prestataire.') });
  } else run('UPDATE refunds SET next_attempt_at=?,updated_at=? WHERE id=?', isoIn(backoffMs(refund.attempts)), now(), refund.id);
}

/** Re-checks `processing` refunds (provider answered "pending") and retries `pending` ones whose backoff elapsed. */
export async function reconcileRefunds(limit = 50) {
  const due = all<RefundRow>(`SELECT * FROM refunds WHERE status IN ('pending','processing')
    AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY COALESCE(next_attempt_at,created_at) LIMIT ?`, now(), limit);
  for (const refund of due) {
    if (refund.status === 'pending') {
      await processRefund(refund.id);
      continue;
    }
    const provider = getProvider(refund.provider);
    const config = readProviderConfig(refund.provider, refund.mode);
    if (!provider || !config || !refund.provider_reference) {
      // Claimed but never answered (crash during the provider call): put it back in the retry queue.
      if (!refund.provider_reference && Date.parse(refund.updated_at) < Date.now() - 10 * 60_000) {
        run("UPDATE refunds SET status='pending',next_attempt_at=?,updated_at=? WHERE id=? AND status='processing'", now(), now(), refund.id);
      }
      continue;
    }
    try {
      applyRefundStatus(refund.id, await provider.status(config, 'refund', refund.provider_reference, providerContext(provider.id), refund.id));
    } catch (error) {
      run('UPDATE refunds SET next_attempt_at=?,last_error=?,updated_at=? WHERE id=?', isoIn(backoffMs(refund.attempts)), safeReason(error), now(), refund.id);
    }
  }
}

/** Admin action: re-queue a failed or waiting refund (never one whose provider call may be in flight). */
export async function retryRefund(refundId: string) {
  const changed = transaction(() => Number(run(`UPDATE refunds SET status='pending',attempts=0,next_attempt_at=NULL,last_error='',updated_at=?
    WHERE id=? AND status IN ('failed','pending')`, now(), refundId).changes));
  return { changed: changed > 0, refund: changed ? await processRefund(refundId) : getRefund(refundId) };
}

export function refundedBaseForIntent(intentId: string): number {
  return one<{ total: number }>('SELECT COALESCE(SUM(amount_base_minor),0) AS total FROM refunds WHERE intent_id=?', intentId)!.total;
}
