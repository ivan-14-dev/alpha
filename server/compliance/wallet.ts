import { all } from '../db.js';
import { balance, ledgerAccounts } from '../payments/ledger.js';
import { baseCurrency, exponent, paymentMode } from '../payments/mode.js';
import { kycView } from './kyc.js';
import { listPayoutMethods } from './payoutMethods.js';
import { inFlightFor, listWithdrawals, withdrawalLimits } from './withdrawals.js';
import { listInvoices } from './invoices.js';
import { emailVerified } from './util.js';

export const journalLabels: Record<string, string> = {
  'campaign.funded': 'Financement de campagne',
  'campaign.refunded': 'Remboursement de campagne',
  'mission.paid': 'Récompense de mission',
  'order.paid': 'Paiement de commande',
  'order.released': 'Vente marketplace',
  'order.refunded': 'Remboursement de commande',
  'withdrawal.requested': 'Demande de retrait',
  'withdrawal.paid': 'Retrait versé',
  'withdrawal.failed': 'Retrait échoué (recrédit)',
  'withdrawal.cancelled': 'Retrait annulé (recrédit)',
  'withdrawal.rejected': 'Retrait refusé (recrédit)',
  adjustment: 'Ajustement administratif',
};

const notices = {
  demo: 'Mode démonstration : les montants affichés dans Alpha sont fictifs. Aucun solde réel n’existe et les retraits sont désactivés.',
  sandbox: 'Mode bac à sable : les paiements passent par des prestataires de test. Les soldes et retraits sont simulés, aucun argent réel ne circule.',
  live: 'Mode réel : vos gains sont des fonds réels, versés sur le moyen de paiement de votre choix après vérification.',
};

const MOVEMENTS = 50;

function movements(userId: string, mode: 'sandbox' | 'live', currency: string) {
  return all<{ journal_id: string; kind: string; memo: string; account: string; amount_minor: number; created_at: string; ref_type: string; ref_id: string }>(
    `SELECT e.journal_id,j.kind,j.memo,e.account,e.amount_minor,j.created_at,j.ref_type,j.ref_id FROM ledger_entries e
     JOIN ledger_journals j ON j.id=e.journal_id WHERE e.account IN (?,?) AND e.mode=? AND e.currency=?
     ORDER BY j.created_at DESC, e.id DESC LIMIT ?`,
    ledgerAccounts.userAvailable(userId), ledgerAccounts.userPending(userId), mode, currency, MOVEMENTS,
  ).map((entry) => ({
    journal_id: entry.journal_id,
    kind: entry.kind,
    label: journalLabels[entry.kind] ?? entry.kind,
    memo: entry.memo,
    bucket: entry.account.endsWith(':pending') ? 'pending' as const : 'available' as const,
    amount_minor: entry.amount_minor,
    currency,
    ref_type: entry.ref_type,
    ref_id: entry.ref_id,
    created_at: entry.created_at,
  }));
}

/** Everything the /wallet page needs in one call. Demo mode has no ledger: balances are null and the UI explains why. */
export function walletView(userId: string) {
  const mode = paymentMode();
  const base = baseCurrency();
  const methods = listPayoutMethods(userId);
  const common = {
    mode,
    notice: notices[mode],
    base_currency: base,
    base_exponent: exponent(base),
    email_verified: emailVerified(userId),
    kyc: kycView(userId),
    payout_methods: methods,
    payout_available: methods.some((method) => method.payout_available),
    withdrawals: listWithdrawals(userId, 20, 0),
    invoices: listInvoices(userId, 20, 0),
  };
  if (mode === 'demo') {
    return { ...common, balances: null, movements: [], limits: withdrawalLimits(userId, null), can_withdraw: false };
  }
  const available = balance(ledgerAccounts.userAvailable(userId), mode, base);
  const pending = balance(ledgerAccounts.userPending(userId), mode, base);
  return {
    ...common,
    balances: { available_minor: available, pending_minor: pending, in_flight_minor: inFlightFor(userId, mode), currency: base },
    movements: movements(userId, mode, base),
    limits: withdrawalLimits(userId, mode),
    can_withdraw: common.email_verified && available > 0 && common.payout_available,
  };
}
