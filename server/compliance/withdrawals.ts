import type { Request } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, notify, now } from '../core.js';
import { journalsFor, ledgerAccounts, postJournal } from '../payments/ledger.js';
import { baseCurrency, paymentMode, payoutFromBase, type LedgerMode } from '../payments/mode.js';
import { providerContext, readProviderConfig } from '../payments/config.js';
import { getProvider } from '../payments/providers/index.js';
import { ProviderError, type ProviderStatus, type WebhookEvent } from '../payments/providers/types.js';
import { recordSignal, riskLevel, type RiskLevel } from '../platform/guards.js';
import { log } from '../platform/log.js';
import { kycApproved } from './kyc.js';
import { getOwnMethod, payoutProviders, payoutRecipient, sharedWithOtherUser, type PayoutMethodRow } from './payoutMethods.js';
import { complianceLimits, payoutRetry } from './settings.js';
import { emailVerified, formatMoney, isoAgo, isoIn } from './util.js';

export type WithdrawalStatus = 'requested' | 'on_hold' | 'approved' | 'processing' | 'paid' | 'failed' | 'rejected' | 'cancelled';
export const openStatuses: WithdrawalStatus[] = ['requested', 'on_hold', 'approved', 'processing'];
const cancellable: WithdrawalStatus[] = ['requested', 'on_hold', 'approved'];
/** Journals that close a withdrawal: at most one may ever exist per withdrawal. */
const terminalKinds = ['withdrawal.paid', 'withdrawal.failed', 'withdrawal.cancelled', 'withdrawal.rejected'];
/** A claimed payout without provider answer for this long is retried with the SAME reference (provider idempotency). */
const STALE_PROCESSING_SECONDS = 15 * 60;

export interface WithdrawalRow {
  id: string;
  user_id: string;
  payout_method_id: string;
  mode: LedgerMode;
  provider: string;
  amount_base_minor: number;
  base_currency: string;
  amount_minor: number;
  currency: string;
  status: WithdrawalStatus;
  risk_level: RiskLevel;
  hold_reason: string;
  review_note: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  payout_reference: string | null;
  provider_reference: string | null;
  failure_reason: string;
  attempts: number;
  next_attempt_at: string | null;
  idempotency_key: string;
  processing_started_at: string | null;
  paid_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const createWithdrawalSchema = z.object({
  amount_minor: z.number().int().positive().max(1e12),
  payout_method_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  idempotency_key: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

const row = (withdrawalId: string) => one<WithdrawalRow>('SELECT * FROM withdrawals WHERE id=?', withdrawalId);

function usage(userId: string, mode: LedgerMode) {
  const sum = (since: string) => one<{ total: number }>(`SELECT COALESCE(SUM(amount_base_minor),0) AS total FROM withdrawals
    WHERE user_id=? AND mode=? AND status NOT IN ('failed','rejected','cancelled') AND created_at>=?`, userId, mode, since)!.total;
  return { daily: sum(isoAgo(86400)), monthly: sum(isoAgo(30 * 86400)) };
}

/** Limits with what remains for the user (rolling 24 h / 30 days) in the given ledger mode. */
export function withdrawalLimits(userId: string, mode: LedgerMode | null) {
  const limits = complianceLimits();
  const used = mode ? usage(userId, mode) : { daily: 0, monthly: 0 };
  const verified = kycApproved(userId);
  return {
    ...limits,
    daily_used_minor: used.daily,
    monthly_used_minor: used.monthly,
    daily_remaining_minor: Math.max(0, limits.daily_limit_minor - used.daily),
    monthly_remaining_minor: Math.max(0, limits.monthly_limit_minor - used.monthly),
    /** Amount still withdrawable without identity verification (null when KYC is approved). */
    without_kyc_remaining_minor: verified ? null : Math.max(0, limits.kyc_required_above_minor - used.monthly),
  };
}

function methodSummary(methodId: string) {
  return one<{ id: string; kind: string; display_mask: string; label: string }>('SELECT id,kind,display_mask,label FROM payout_methods WHERE id=?', methodId) ?? null;
}

/** Member view: internal risk details stay hidden. */
export function withdrawalView(withdrawal: WithdrawalRow) {
  return {
    id: withdrawal.id,
    status: withdrawal.status,
    mode: withdrawal.mode,
    amount_base_minor: withdrawal.amount_base_minor,
    base_currency: withdrawal.base_currency,
    amount_minor: withdrawal.amount_minor,
    currency: withdrawal.currency,
    provider: withdrawal.provider,
    method: methodSummary(withdrawal.payout_method_id),
    review_note: withdrawal.status === 'rejected' ? withdrawal.review_note : '',
    failure_reason: withdrawal.failure_reason,
    attempts: withdrawal.attempts,
    next_attempt_at: withdrawal.next_attempt_at,
    created_at: withdrawal.created_at,
    updated_at: withdrawal.updated_at,
    paid_at: withdrawal.paid_at,
    closed_at: withdrawal.closed_at,
    can_cancel: cancellable.includes(withdrawal.status),
  };
}

export function adminWithdrawalView(withdrawal: WithdrawalRow & { user_name?: string; user_email?: string }) {
  return {
    ...withdrawalView(withdrawal),
    user_id: withdrawal.user_id,
    user_name: withdrawal.user_name,
    user_email: withdrawal.user_email,
    risk_level: withdrawal.risk_level,
    hold_reason: withdrawal.hold_reason,
    review_note: withdrawal.review_note,
    reviewed_by: withdrawal.reviewed_by,
    reviewed_at: withdrawal.reviewed_at,
    payout_reference: withdrawal.payout_reference,
    provider_reference: withdrawal.provider_reference,
    processing_started_at: withdrawal.processing_started_at,
    kyc_status: one<{ status: string }>('SELECT status FROM kyc_profiles WHERE user_id=?', withdrawal.user_id)?.status ?? 'none',
  };
}

export function listWithdrawals(userId: string, limit = 20, offset = 0) {
  return {
    total: one<{ count: number }>('SELECT COUNT(*) AS count FROM withdrawals WHERE user_id=?', userId)!.count,
    withdrawals: all<WithdrawalRow>('SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC, id LIMIT ? OFFSET ?', userId, limit, offset).map(withdrawalView),
  };
}

export function inFlightFor(userId: string, mode: LedgerMode): number {
  return one<{ total: number }>(`SELECT COALESCE(SUM(amount_base_minor),0) AS total FROM withdrawals WHERE user_id=? AND mode=?
    AND status IN ('requested','on_hold','approved','processing')`, userId, mode)!.total;
}

/** Defence in depth on top of the status machine: a withdrawal is closed by exactly one journal. */
function assertOpenInLedger(withdrawalId: string) {
  if (journalsFor('withdrawal', withdrawalId).some((journal) => terminalKinds.includes(journal.kind))) {
    throw new Error(`Le retrait ${withdrawalId} est déjà clôturé dans le grand livre.`);
  }
}

/** Returns the funds to the user's available balance (cancel / reject / failure). Call inside a transaction. */
function reverseFunds(withdrawal: WithdrawalRow, kind: 'withdrawal.cancelled' | 'withdrawal.rejected' | 'withdrawal.failed', actorId: string | null, memo: string) {
  assertOpenInLedger(withdrawal.id);
  postJournal({
    idempotencyKey: `${kind}:${withdrawal.id}`, kind, mode: withdrawal.mode, currency: withdrawal.base_currency,
    refType: 'withdrawal', refId: withdrawal.id, memo, actorId,
    legs: [
      { account: ledgerAccounts.withdrawalsInFlight(), amountMinor: -withdrawal.amount_base_minor },
      { account: ledgerAccounts.userAvailable(withdrawal.user_id), amountMinor: withdrawal.amount_base_minor },
    ],
    nonNegative: [ledgerAccounts.withdrawalsInFlight()],
  });
}

const signal = (req: Request | null, userId: string, kind: 'withdrawal' | 'payout', meta: Record<string, unknown>) => {
  try { recordSignal(req, userId, kind, meta); } catch (error) { log.warn('compliance.signal_failed', { error }); }
};

export function createWithdrawal(req: Request, userId: string, input: z.infer<typeof createWithdrawalSchema>) {
  const mode = paymentMode();
  if (mode === 'demo') throw new HttpError(409, 'Les retraits sont indisponibles en mode démonstration : aucun solde réel n’existe.');
  if (!emailVerified(userId)) throw new HttpError(403, 'Vérifiez votre adresse e-mail avant de demander un retrait.');
  const method = getOwnMethod(userId, input.payout_method_id);
  const idempotencyKey = input.idempotency_key ?? id();
  const replay = one<WithdrawalRow>('SELECT * FROM withdrawals WHERE user_id=? AND idempotency_key=?', userId, idempotencyKey);
  if (replay) return { withdrawal: replayed(replay, input), created: false };
  const base = baseCurrency();
  const limits = complianceLimits();
  if (input.amount_minor < limits.min_withdrawal_minor) throw new HttpError(400, `Le montant minimum de retrait est de ${formatMoney(limits.min_withdrawal_minor, base)}.`);
  let amountMinor: number;
  try { amountMinor = payoutFromBase(input.amount_minor, method.currency); } catch { throw new HttpError(400, `Aucun taux de change n’est configuré pour ${method.currency}.`); }
  if (amountMinor <= 0) throw new HttpError(400, 'Montant trop faible une fois converti dans la devise de versement.');
  const provider = payoutProviders(method)[0];
  if (!provider) throw new HttpError(409, 'Aucun prestataire de versement n’est disponible pour ce moyen de versement. Réessayez plus tard ou choisissez un autre moyen.');
  const risk = riskLevel(userId);
  const withdrawalId = id();
  const created = transaction(() => {
    const raced = one<WithdrawalRow>('SELECT * FROM withdrawals WHERE user_id=? AND idempotency_key=?', userId, idempotencyKey);
    if (raced) return { withdrawal: raced, created: false };
    const used = usage(userId, mode);
    if (used.daily + input.amount_minor > limits.daily_limit_minor) {
      throw new HttpError(409, `Plafond journalier atteint : vous pouvez encore retirer ${formatMoney(Math.max(0, limits.daily_limit_minor - used.daily), base)} sur 24 heures.`);
    }
    if (used.monthly + input.amount_minor > limits.monthly_limit_minor) {
      throw new HttpError(409, `Plafond mensuel atteint : vous pouvez encore retirer ${formatMoney(Math.max(0, limits.monthly_limit_minor - used.monthly), base)} sur 30 jours.`);
    }
    if (used.monthly + input.amount_minor > limits.kyc_required_above_minor && !kycApproved(userId)) {
      throw new HttpError(403, `Vérification d’identité requise au-delà de ${formatMoney(limits.kyc_required_above_minor, base)} de retraits sur 30 jours.`);
    }
    const holdReasons: string[] = [];
    if (risk === 'high') holdReasons.push('niveau de risque élevé');
    if (input.amount_minor > limits.manual_review_above_minor) holdReasons.push('montant supérieur au seuil de revue manuelle');
    if (sharedWithOtherUser(method)) holdReasons.push('moyen de versement enregistré par un autre compte');
    const status: WithdrawalStatus = holdReasons.length ? 'on_hold' : 'approved';
    postJournal({
      idempotencyKey: `withdrawal.requested:${withdrawalId}`, kind: 'withdrawal.requested', mode, currency: base,
      refType: 'withdrawal', refId: withdrawalId, memo: `Retrait vers ${method.display_mask}`, actorId: userId,
      legs: [
        { account: ledgerAccounts.userAvailable(userId), amountMinor: -input.amount_minor },
        { account: ledgerAccounts.withdrawalsInFlight(), amountMinor: input.amount_minor },
      ],
      nonNegative: [ledgerAccounts.userAvailable(userId)],
    });
    const timestamp = now();
    run(`INSERT INTO withdrawals(id,user_id,payout_method_id,mode,provider,amount_base_minor,base_currency,amount_minor,currency,status,risk_level,
      hold_reason,idempotency_key,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    withdrawalId, userId, method.id, mode, provider.id, input.amount_minor, base, amountMinor, method.currency, status, risk,
    holdReasons.join(' ; '), idempotencyKey, status === 'approved' ? timestamp : null, timestamp, timestamp);
    const amount = formatMoney(input.amount_minor, base);
    if (status === 'on_hold') notify(userId, 'compliance.withdrawal_on_hold', 'Retrait en cours de vérification', `Votre demande de retrait de ${amount} sera examinée par notre équipe avant versement.`, '/wallet');
    else notify(userId, 'compliance.withdrawal_requested', 'Retrait enregistré', `Votre retrait de ${amount} vers ${method.display_mask} va être versé.`, '/wallet');
    return { withdrawal: row(withdrawalId)!, created: true };
  });
  if (created.created) signal(req, userId, 'withdrawal', { withdrawal_id: withdrawalId, amount_base_minor: input.amount_minor, status: created.withdrawal.status, provider: provider.id });
  return { withdrawal: created.created ? withdrawalView(created.withdrawal) : replayed(created.withdrawal, input), created: created.created };
}

function replayed(existing: WithdrawalRow, input: z.infer<typeof createWithdrawalSchema>) {
  if (existing.payout_method_id !== input.payout_method_id || existing.amount_base_minor !== input.amount_minor) {
    throw new HttpError(409, 'Cette clé d’idempotence a déjà servi pour un autre retrait.');
  }
  return withdrawalView(existing);
}

export function cancelWithdrawal(userId: string, withdrawalId: string) {
  return transaction(() => {
    const withdrawal = row(withdrawalId);
    if (!withdrawal || withdrawal.user_id !== userId) throw new HttpError(404, 'Retrait introuvable.');
    if (!cancellable.includes(withdrawal.status)) throw new HttpError(409, withdrawal.status === 'processing' ? 'Le versement est déjà en cours auprès du prestataire : il ne peut plus être annulé.' : 'Ce retrait ne peut plus être annulé.');
    const timestamp = now();
    const changed = run("UPDATE withdrawals SET status='cancelled',closed_at=?,next_attempt_at=NULL,updated_at=? WHERE id=? AND status=?", timestamp, timestamp, withdrawal.id, withdrawal.status);
    if (Number(changed.changes) !== 1) throw new HttpError(409, 'Ce retrait a changé d’état. Actualisez la page.');
    reverseFunds(withdrawal, 'withdrawal.cancelled', userId, 'Retrait annulé par l’utilisateur');
    notify(userId, 'compliance.withdrawal_cancelled', 'Retrait annulé', `${formatMoney(withdrawal.amount_base_minor, withdrawal.base_currency)} ont été recrédités sur votre solde disponible.`, '/wallet');
    return withdrawalView(row(withdrawal.id)!);
  });
}

export function adminWithdrawals(status: WithdrawalStatus | 'open' | 'all', limit: number, offset: number) {
  const filter = status === 'all' ? '1=1' : status === 'open' ? "w.status IN ('requested','on_hold','approved','processing')" : 'w.status=?';
  const params = status === 'all' || status === 'open' ? [] : [status];
  const rows = all<WithdrawalRow & { user_name: string; user_email: string }>(`SELECT w.*,u.name AS user_name,u.email AS user_email FROM withdrawals w
    JOIN users u ON u.id=w.user_id WHERE ${filter} ORDER BY w.created_at ASC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = one<{ count: number }>(`SELECT COUNT(*) AS count FROM withdrawals w WHERE ${filter}`, ...params)!.count;
  return { total, withdrawals: rows.map(adminWithdrawalView) };
}

function adminRow(withdrawalId: string) {
  const withdrawal = row(withdrawalId);
  if (!withdrawal) throw new HttpError(404, 'Retrait introuvable.');
  return withdrawal;
}

function withUser(withdrawalId: string) {
  return adminWithdrawalView(one<WithdrawalRow & { user_name: string; user_email: string }>(
    'SELECT w.*,u.name AS user_name,u.email AS user_email FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.id=?', withdrawalId)!);
}

export function adminApproveWithdrawal(adminId: string, withdrawalId: string, note: string) {
  return transaction(() => {
    const withdrawal = adminRow(withdrawalId);
    if (withdrawal.user_id === adminId) throw new HttpError(403, 'Vous ne pouvez pas approuver votre propre retrait.');
    if (withdrawal.status !== 'on_hold' && withdrawal.status !== 'requested') throw new HttpError(409, 'Seul un retrait en attente de revue peut être approuvé.');
    const timestamp = now();
    run("UPDATE withdrawals SET status='approved',review_note=?,reviewed_by=?,reviewed_at=?,next_attempt_at=?,updated_at=? WHERE id=? AND status=?",
      note, adminId, timestamp, timestamp, timestamp, withdrawal.id, withdrawal.status);
    audit(adminId, 'compliance.withdrawal_approved', 'withdrawal', withdrawal.id, note);
    notify(withdrawal.user_id, 'compliance.withdrawal_approved', 'Retrait approuvé', `Votre retrait de ${formatMoney(withdrawal.amount_base_minor, withdrawal.base_currency)} a été approuvé et va être versé.`, '/wallet');
    return withUser(withdrawal.id);
  });
}

export function adminRejectWithdrawal(adminId: string, withdrawalId: string, reason: string) {
  return transaction(() => {
    const withdrawal = adminRow(withdrawalId);
    if (!cancellable.includes(withdrawal.status)) throw new HttpError(409, 'Ce retrait ne peut plus être rejeté (versement en cours ou clôturé).');
    const timestamp = now();
    const changed = run("UPDATE withdrawals SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=?,closed_at=?,next_attempt_at=NULL,updated_at=? WHERE id=? AND status=?",
      reason, adminId, timestamp, timestamp, timestamp, withdrawal.id, withdrawal.status);
    if (Number(changed.changes) !== 1) throw new HttpError(409, 'Ce retrait a changé d’état. Actualisez la page.');
    reverseFunds(withdrawal, 'withdrawal.rejected', adminId, `Retrait rejeté : ${reason}`.slice(0, 500));
    audit(adminId, 'compliance.withdrawal_rejected', 'withdrawal', withdrawal.id, reason);
    notify(withdrawal.user_id, 'compliance.withdrawal_rejected', 'Retrait refusé', `Motif : ${reason} Le montant a été recrédité sur votre solde disponible.`, '/wallet');
    return withUser(withdrawal.id);
  });
}

/** Brings a scheduled retry or a pending provider check forward to now. */
export function adminRetryWithdrawal(adminId: string, withdrawalId: string) {
  return transaction(() => {
    const withdrawal = adminRow(withdrawalId);
    const retryable = (withdrawal.status === 'approved') || (withdrawal.status === 'processing' && !!withdrawal.provider_reference);
    if (!retryable) throw new HttpError(409, 'Seul un retrait approuvé (en attente de nouvelle tentative) ou en vérification auprès du prestataire peut être relancé.');
    const timestamp = now();
    run('UPDATE withdrawals SET next_attempt_at=?,updated_at=? WHERE id=?', timestamp, timestamp, withdrawal.id);
    audit(adminId, 'compliance.withdrawal_retry', 'withdrawal', withdrawal.id, `tentatives: ${withdrawal.attempts}`);
    return withUser(withdrawal.id);
  });
}

/** Payment webhooks are hints: schedule an immediate status check by the next `compliance.payouts` run. */
export function payoutWebhookHint(reference: string) {
  run(`UPDATE withdrawals SET next_attempt_at=?,updated_at=? WHERE status='processing' AND provider_reference IS NOT NULL
    AND (id=? OR payout_reference=? OR provider_reference=?)`, now(), now(), reference, reference, reference);
}

/**
 * Payout webhook handler (registered with payments/webhooks.ts). The payload is never trusted: the outcome is re-confirmed
 * with provider.status(). Before the payout call has returned (no provider reference yet), the job reconciles the answer.
 */
export async function handlePayoutWebhook(providerId: string, mode: LedgerMode, event: WebhookEvent) {
  const references = [...new Set([event.reference, event.providerReference].filter((value): value is string => !!value))];
  if (!references.length) return;
  const marks = references.map(() => '?').join(',');
  const withdrawal = one<WithdrawalRow>(`SELECT * FROM withdrawals WHERE provider=? AND mode=? AND status='processing' AND provider_reference IS NOT NULL
    AND (id IN (${marks}) OR payout_reference IN (${marks}) OR provider_reference IN (${marks})) LIMIT 1`,
  providerId, mode, ...references, ...references, ...references);
  if (withdrawal) await checkPayout(withdrawal);
}

// ---------------------------------------------------------------- payout job

function markPaid(withdrawalId: string, providerReference: string) {
  const paid = transaction(() => {
    const withdrawal = row(withdrawalId);
    if (!withdrawal || withdrawal.status !== 'processing') return null;
    const timestamp = now();
    run("UPDATE withdrawals SET status='paid',provider_reference=?,paid_at=?,closed_at=?,failure_reason='',next_attempt_at=NULL,updated_at=? WHERE id=? AND status='processing'",
      providerReference, timestamp, timestamp, timestamp, withdrawal.id);
    assertOpenInLedger(withdrawal.id);
    postJournal({
      idempotencyKey: `withdrawal.paid:${withdrawal.id}`, kind: 'withdrawal.paid', mode: withdrawal.mode, currency: withdrawal.base_currency,
      refType: 'withdrawal', refId: withdrawal.id, memo: `Versement ${withdrawal.provider} ${providerReference}`.slice(0, 500),
      legs: [
        { account: ledgerAccounts.withdrawalsInFlight(), amountMinor: -withdrawal.amount_base_minor },
        { account: ledgerAccounts.provider(withdrawal.provider), amountMinor: withdrawal.amount_base_minor },
      ],
      nonNegative: [ledgerAccounts.withdrawalsInFlight()],
    });
    run('UPDATE payout_methods SET verified_at=COALESCE(verified_at,?) WHERE id=?', timestamp, withdrawal.payout_method_id);
    notify(withdrawal.user_id, 'compliance.withdrawal_paid', 'Retrait versé', `${formatMoney(withdrawal.amount_minor, withdrawal.currency)} ont été envoyés vers votre moyen de versement.`, '/wallet');
    return withdrawal;
  });
  if (paid) signal(null, paid.user_id, 'payout', { withdrawal_id: paid.id, provider: paid.provider, amount_base_minor: paid.amount_base_minor });
}

function failNow(withdrawal: WithdrawalRow, reason: string) {
  const timestamp = now();
  run("UPDATE withdrawals SET status='failed',failure_reason=?,closed_at=?,next_attempt_at=NULL,updated_at=? WHERE id=?", reason, timestamp, timestamp, withdrawal.id);
  reverseFunds(withdrawal, 'withdrawal.failed', null, `Échec du versement : ${reason}`.slice(0, 500));
  notify(withdrawal.user_id, 'compliance.withdrawal_failed', 'Échec du retrait', `Le versement n’a pas pu être effectué (${reason}). ${formatMoney(withdrawal.amount_base_minor, withdrawal.base_currency)} ont été recrédités sur votre solde.`, '/wallet');
}

/**
 * outcome 'declined': the provider confirmed nothing was paid → retry with a NEW reference, then fail and refund.
 * outcome 'unknown': network/server error, money may have moved → retry with the SAME reference (idempotent at the
 * provider); after the last attempt the withdrawal is held for manual reconciliation instead of being refunded.
 * outcome 'invalid': the provider refused the request (non retryable) → fail and refund immediately.
 */
function afterFailedAttempt(withdrawalId: string, outcome: 'declined' | 'unknown' | 'invalid', reason: string) {
  const settings = payoutRetry();
  transaction(() => {
    const withdrawal = row(withdrawalId);
    if (!withdrawal || withdrawal.status !== 'processing') return;
    const message = reason.slice(0, 300) || 'Erreur du prestataire';
    if (outcome === 'invalid') { failNow(withdrawal, message); return; }
    const timestamp = now();
    if (withdrawal.attempts < settings.max_attempts) {
      const delay = Math.min(86400, settings.base_delay_seconds * 2 ** (withdrawal.attempts - 1));
      const reference = outcome === 'declined' ? `${withdrawal.id}-r${withdrawal.attempts}` : withdrawal.payout_reference;
      run(`UPDATE withdrawals SET status='approved',failure_reason=?,payout_reference=?,provider_reference=NULL,processing_started_at=NULL,
        next_attempt_at=?,updated_at=? WHERE id=?`, message, reference, isoIn(delay), timestamp, withdrawal.id);
      return;
    }
    if (outcome === 'declined') { failNow(withdrawal, message); return; }
    run(`UPDATE withdrawals SET status='on_hold',failure_reason=?,hold_reason=?,next_attempt_at=NULL,updated_at=? WHERE id=?`, message,
      `Résultat du versement inconnu après ${withdrawal.attempts} tentatives : vérifiez auprès du prestataire avant d’approuver (nouvel essai) ou de rejeter (recrédit).`,
      timestamp, withdrawal.id);
    log.error('compliance.payout_unknown_outcome', { withdrawal_id: withdrawal.id, provider: withdrawal.provider, attempts: withdrawal.attempts });
  });
}

function settle(withdrawalId: string, status: ProviderStatus, providerReference: string, failureReason?: string) {
  if (status === 'succeeded') { markPaid(withdrawalId, providerReference); return; }
  if (status === 'pending') {
    run("UPDATE withdrawals SET provider_reference=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='processing'",
      providerReference, isoIn(payoutRetry().status_check_seconds), now(), withdrawalId);
    return;
  }
  afterFailedAttempt(withdrawalId, 'declined', failureReason ?? (status === 'cancelled' ? 'Versement annulé par le prestataire' : 'Versement refusé par le prestataire'));
}

function classify(error: unknown): { outcome: 'unknown' | 'invalid'; reason: string } {
  if (error instanceof ProviderError) return { outcome: error.retryable ? 'unknown' : 'invalid', reason: error.message };
  if (error instanceof HttpError) return { outcome: 'invalid', reason: error.message };
  return { outcome: 'unknown', reason: 'Erreur technique lors de l’appel au prestataire' };
}

async function attemptPayout(withdrawalId: string) {
  const claimed = transaction(() => {
    const withdrawal = row(withdrawalId);
    if (!withdrawal || withdrawal.status !== 'approved') return null;
    const timestamp = now();
    const reference = withdrawal.payout_reference ?? withdrawal.id;
    const changed = run(`UPDATE withdrawals SET status='processing',attempts=attempts+1,payout_reference=?,processing_started_at=?,next_attempt_at=NULL,updated_at=?
      WHERE id=? AND status='approved'`, reference, timestamp, timestamp, withdrawal.id);
    return Number(changed.changes) === 1 ? row(withdrawal.id)! : null;
  });
  if (!claimed) return;
  try {
    const provider = getProvider(claimed.provider);
    const config = readProviderConfig(claimed.provider, claimed.mode);
    if (!provider?.payout || !config || !provider.capabilities.payout) throw new ProviderError(claimed.provider as never, 'Prestataire de versement désactivé ou non configuré', true);
    const method = one<PayoutMethodRow>('SELECT * FROM payout_methods WHERE id=?', claimed.payout_method_id)!;
    const user = one<{ name: string; email: string }>('SELECT name,email FROM users WHERE id=?', claimed.user_id)!;
    const result = await provider.payout(config, {
      reference: claimed.payout_reference!, amountMinor: claimed.amount_minor, currency: claimed.currency,
      description: `Alpha - retrait ${claimed.id.slice(0, 8)}`, recipient: payoutRecipient(method, user),
    }, providerContext(claimed.provider));
    settle(claimed.id, result.status, result.providerReference, result.failureReason);
  } catch (error) {
    const { outcome, reason } = classify(error);
    log.warn('compliance.payout_attempt_failed', { withdrawal_id: claimed.id, provider: claimed.provider, attempt: claimed.attempts, outcome, error });
    afterFailedAttempt(claimed.id, outcome, reason);
  }
}

async function checkPayout(withdrawal: WithdrawalRow) {
  try {
    const provider = getProvider(withdrawal.provider);
    const config = readProviderConfig(withdrawal.provider, withdrawal.mode);
    if (!provider || !config) throw new Error('Prestataire indisponible');
    const result = await provider.status(config, 'payout', withdrawal.provider_reference!, providerContext(withdrawal.provider), withdrawal.payout_reference ?? undefined);
    const current = row(withdrawal.id);
    if (current?.status !== 'processing') return;
    settle(withdrawal.id, result.status, result.providerReference || withdrawal.provider_reference!, result.failureReason);
  } catch (error) {
    log.warn('compliance.payout_status_failed', { withdrawal_id: withdrawal.id, provider: withdrawal.provider, error });
    run("UPDATE withdrawals SET next_attempt_at=?,updated_at=? WHERE id=? AND status='processing'", isoIn(payoutRetry().status_check_seconds), now(), withdrawal.id);
  }
}

/** Job `compliance.payouts`: claims approved withdrawals, calls providers OUTSIDE transactions, re-checks pending payouts. */
export async function processPayouts(limit = 25) {
  const timestamp = now();
  // Crash recovery: a claim without any provider answer is retried with the same idempotent reference.
  run(`UPDATE withdrawals SET status='approved',next_attempt_at=?,updated_at=? WHERE status='processing' AND provider_reference IS NULL
    AND processing_started_at<?`, timestamp, timestamp, isoAgo(STALE_PROCESSING_SECONDS));
  const due = all<{ id: string }>(`SELECT id FROM withdrawals WHERE status='approved' AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    ORDER BY created_at LIMIT ?`, timestamp, limit);
  for (const item of due) await attemptPayout(item.id);
  const pending = all<WithdrawalRow>(`SELECT * FROM withdrawals WHERE status='processing' AND provider_reference IS NOT NULL
    AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY updated_at LIMIT ?`, now(), limit);
  for (const withdrawal of pending) await checkPayout(withdrawal);
  return { attempted: due.length, checked: pending.length };
}

export function withdrawalCounts() {
  return one<{ on_hold: number; approved: number; processing: number; failed_30d: number }>(`SELECT
    COALESCE(SUM(status IN ('on_hold','requested')),0) AS on_hold, COALESCE(SUM(status='approved'),0) AS approved,
    COALESCE(SUM(status='processing'),0) AS processing, COALESCE(SUM(status='failed' AND updated_at>=?),0) AS failed_30d FROM withdrawals`, isoAgo(30 * 86400))!;
}

export function exportWithdrawals(userId: string) {
  return all<WithdrawalRow>('SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at', userId).map(withdrawalView);
}
