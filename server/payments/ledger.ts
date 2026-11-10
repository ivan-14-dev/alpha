import { all, one, run, transaction } from '../db.js';
import { HttpError, id } from '../core.js';
import type { LedgerMode } from './mode.js';

/**
 * Balanced double-entry ledger (tables in 004-platform.sql, immutable via triggers).
 * Sign convention: an account balance is SUM(amount_minor). Every journal sums to zero.
 *
 * Funding a campaign  : provider:<p> -X, escrow:campaign:<id> +X
 * Paying a tester     : escrow:campaign:<id> -X, user:<id>:available +X-fee, platform:fees +fee
 * Withdrawal request  : user:<id>:available -X, withdrawals:in_flight +X
 * Withdrawal paid     : withdrawals:in_flight -X, provider:<p> +X
 * Withdrawal failed   : withdrawals:in_flight -X, user:<id>:available +X
 * Refund              : escrow:order:<id> -X, provider:<p> +X
 */
export const ledgerAccounts = {
  userAvailable: (userId: string) => `user:${userId}:available`,
  userPending: (userId: string) => `user:${userId}:pending`,
  campaignEscrow: (campaignId: string) => `escrow:campaign:${campaignId}`,
  orderEscrow: (orderId: string) => `escrow:order:${orderId}`,
  provider: (providerId: string) => `provider:${providerId}`,
  platformFees: () => 'platform:fees',
  platformTaxes: () => 'platform:taxes',
  withdrawalsInFlight: () => 'withdrawals:in_flight',
  adjustments: () => 'platform:adjustments',
};

export interface Leg { account: string; amountMinor: number }
export interface JournalInput {
  idempotencyKey: string;
  kind: string;
  mode: LedgerMode;
  currency: string;
  refType: string;
  refId: string;
  memo?: string;
  actorId?: string | null;
  legs: Leg[];
  /** Accounts that must not go negative after posting (e.g. user available balance, escrow). */
  nonNegative?: string[];
}

/** Idempotent: re-posting the same key returns the existing journal id without writing. */
export function postJournal(input: JournalInput): { journalId: string; created: boolean } {
  return transaction(() => {
    const existing = one<{ id: string; kind: string; ref_id: string }>('SELECT id,kind,ref_id FROM ledger_journals WHERE idempotency_key=?', input.idempotencyKey);
    if (existing) {
      if (existing.kind !== input.kind || existing.ref_id !== input.refId) throw new Error('Cle d’idempotence du grand livre reutilisee pour une autre operation.');
      return { journalId: existing.id, created: false };
    }
    const merged = new Map<string, number>();
    for (const leg of input.legs) {
      if (!Number.isSafeInteger(leg.amountMinor)) throw new Error('Montant de grand livre invalide.');
      merged.set(leg.account, (merged.get(leg.account) ?? 0) + leg.amountMinor);
    }
    const legs = [...merged].filter(([, amount]) => amount !== 0);
    if (legs.length < 2) throw new Error('Une ecriture doit comporter au moins deux comptes.');
    if (legs.reduce((sum, [, amount]) => sum + amount, 0) !== 0) throw new Error('Ecriture non equilibree.');
    const journalId = id();
    run(`INSERT INTO ledger_journals(id,idempotency_key,kind,mode,currency,ref_type,ref_id,memo,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`, journalId, input.idempotencyKey, input.kind, input.mode, input.currency,
    input.refType, input.refId, input.memo ?? '', input.actorId ?? null);
    for (const [account, amount] of legs) {
      run('INSERT INTO ledger_entries(id,journal_id,account,amount_minor,currency,mode) VALUES (?,?,?,?,?,?)',
        id(), journalId, account, amount, input.currency, input.mode);
    }
    for (const account of input.nonNegative ?? []) {
      if (balance(account, input.mode, input.currency) < 0) throw new HttpError(409, 'Solde insuffisant pour cette opération.');
    }
    return { journalId, created: true };
  });
}

export function balance(account: string, mode: LedgerMode, currency: string): number {
  return one<{ total: number }>('SELECT COALESCE(SUM(amount_minor),0) AS total FROM ledger_entries WHERE account=? AND mode=? AND currency=?',
    account, mode, currency)!.total;
}

export function journalsFor(refType: string, refId: string) {
  return all<{ id: string; kind: string; mode: LedgerMode; currency: string; memo: string; created_at: string }>(
    'SELECT id,kind,mode,currency,memo,created_at FROM ledger_journals WHERE ref_type=? AND ref_id=? ORDER BY created_at,id', refType, refId);
}

/** Global invariant used by health checks and tests: every mode/currency nets to zero. */
export function ledgerIsBalanced(): boolean {
  return all('SELECT mode,currency FROM ledger_entries GROUP BY mode,currency HAVING SUM(amount_minor)!=0').length === 0;
}
