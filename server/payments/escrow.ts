import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, notify, now } from '../core.js';
import { balance, ledgerAccounts, postJournal } from './ledger.js';
import type { LedgerMode, PaymentMode } from './mode.js';
import { campaignMoneyRow, hasDemoFunds, remainingToFund, reservedCents } from './core/budget.js';
import { computeFee, feeSettings } from './core/fees.js';
import { insertOrderEvent } from './core/orders.js';
import { createRefund, refundedBaseForIntent } from './core/refunds.js';
import { alertAdmins, formatMoney, getIntent, type IntentRow } from './core/store.js';

/**
 * Escrow contract shared with trust (disputes) and compliance. OWNER: payments-core module.
 * Campaigns and orders lock the payment mode at funding/purchase time; demo resources keep V3 behaviour.
 * Every function that writes must run inside a transaction (they open a SAVEPOINT when nested).
 */
export function orderPaymentMode(orderId: string): PaymentMode {
  return one<{ payment_mode: PaymentMode }>('SELECT payment_mode FROM orders WHERE id=?', orderId)?.payment_mode ?? 'demo';
}
export function campaignPaymentMode(campaignId: string): PaymentMode {
  return one<{ payment_mode: PaymentMode }>('SELECT payment_mode FROM campaigns WHERE id=?', campaignId)?.payment_mode ?? 'demo';
}

const money = (amount: number, currency: string) => formatMoney(amount, currency);
const ledgerCurrency = (mode: LedgerMode, account: string) =>
  one<{ currency: string }>('SELECT currency FROM ledger_entries WHERE account=? AND mode=? ORDER BY created_at LIMIT 1', account, mode)?.currency;

/** Why a succeeded intent can no longer be applied (null = applicable). Runs inside the settlement transaction. */
function settlementBlocker(intent: IntentRow): string | null {
  if (intent.purpose === 'campaign_funding') {
    const campaign = campaignMoneyRow(intent.ref_id);
    if (!campaign) return 'La campagne n’existe plus.';
    if (campaign.status !== 'open') return 'La campagne est fermée.';
    if (campaign.payment_mode === 'demo' ? hasDemoFunds(campaign.id) : campaign.payment_mode !== intent.mode) {
      return 'La campagne utilise un autre mode de paiement.';
    }
    if (remainingToFund(campaign, intent.mode) < intent.amount_base_minor) return 'Le budget de la campagne est déjà financé.';
    return null;
  }
  const listing = one<{ seller_id: string; status: string; price_cents: number }>('SELECT seller_id,status,price_cents FROM listings WHERE id=?', intent.ref_id);
  if (!listing) return 'L’offre n’existe plus.';
  if (listing.status !== 'active') return 'L’offre a été archivée.';
  if (listing.seller_id === intent.user_id) return 'Achat de sa propre offre.';
  if (listing.price_cents !== intent.amount_base_minor) return 'Le prix de l’offre a changé depuis le paiement.';
  if (one("SELECT id FROM orders WHERE listing_id=? AND buyer_id=? AND status IN ('paid','delivered','disputed')", intent.ref_id, intent.user_id)) {
    return 'Une commande active existe déjà pour cette offre.';
  }
  return null;
}

/**
 * Credits a provider-confirmed collection exactly once (`campaign.funded` / `order.paid`, keyed by intent).
 * A payment that can no longer be applied (late success on a closed campaign, archived listing...) is marked
 * `unapplied` and refunded automatically. Never call it before re-confirming the payment with `status()`.
 */
export function settleSucceededIntent(intentId: string, source: string): { applied: boolean; orderId: string | null } {
  return transaction(() => {
    const intent = getIntent(intentId);
    if (!intent) throw new HttpError(404, 'Paiement introuvable.');
    if (intent.settlement !== 'none' || intent.review_required) return { applied: intent.settlement === 'settled', orderId: intent.order_id };
    const blocker = settlementBlocker(intent);
    const amount = intent.amount_base_minor;
    if (blocker) {
      run(`UPDATE payment_intents SET status='succeeded',settlement='unapplied',failure_reason=?,next_check_at=NULL,updated_at=? WHERE id=?`,
        `Paiement reçu mais non applicable : ${blocker} Remboursement automatique.`, now(), intent.id);
      createRefund({ intent: getIntent(intent.id)!, amountBaseMinor: amount, reason: blocker, requestedBy: null,
        campaignId: intent.purpose === 'campaign_funding' ? intent.ref_id : null });
      notify(intent.user_id, 'payment', 'Paiement reçu, remboursement en cours',
        `${blocker} Votre paiement de ${money(intent.amount_minor, intent.currency)} va être remboursé.`, `/checkout/return?intent=${intent.id}`);
      alertAdmins('Paiement non applicable', `Intention ${intent.id} (${intent.provider}) : ${blocker} Remboursement automatique lancé.`);
      audit(intent.user_id, 'payments.intent.unapplied', 'payment_intent', intent.id, `${source}: ${blocker}`);
      return { applied: false, orderId: null };
    }
    if (intent.purpose === 'campaign_funding') {
      const campaign = campaignMoneyRow(intent.ref_id)!;
      run("UPDATE campaigns SET payment_mode=? WHERE id=? AND payment_mode='demo'", intent.mode, campaign.id);
      const { journalId } = postJournal({
        idempotencyKey: `campaign.funded:${intent.id}`, kind: 'campaign.funded', mode: intent.mode, currency: intent.base_currency,
        refType: 'payment_intent', refId: intent.id, memo: `Financement campagne ${campaign.id}`, actorId: intent.user_id,
        legs: [{ account: ledgerAccounts.provider(intent.provider), amountMinor: -amount }, { account: ledgerAccounts.campaignEscrow(campaign.id), amountMinor: amount }],
      });
      run(`UPDATE payment_intents SET status='succeeded',settlement='settled',settled_journal_id=?,failure_reason='',next_check_at=NULL,updated_at=? WHERE id=?`,
        journalId, now(), intent.id);
      notify(campaign.owner_id, 'payment', 'Financement reçu', `${money(amount, intent.base_currency)} placés en séquestre pour « ${campaign.title} ».`, `/missions/${campaign.id}`);
      audit(intent.user_id, 'payments.campaign.funded', 'campaign', campaign.id, JSON.stringify({ intent_id: intent.id, amount_minor: amount, mode: intent.mode, source }));
      return { applied: true, orderId: null };
    }
    const listing = one<{ id: string; seller_id: string; title: string }>('SELECT id,seller_id,title FROM listings WHERE id=?', intent.ref_id)!;
    const orderId = id();
    run("INSERT INTO orders (id,listing_id,buyer_id,seller_id,price_cents,status,payment_mode) VALUES (?,?,?,?,?,'paid',?)",
      orderId, listing.id, intent.user_id, listing.seller_id, amount, intent.mode);
    insertOrderEvent(orderId, intent.user_id, 'purchased');
    const { journalId } = postJournal({
      idempotencyKey: `order.paid:${intent.id}`, kind: 'order.paid', mode: intent.mode, currency: intent.base_currency,
      refType: 'payment_intent', refId: intent.id, memo: `Achat commande ${orderId}`, actorId: intent.user_id,
      legs: [{ account: ledgerAccounts.provider(intent.provider), amountMinor: -amount }, { account: ledgerAccounts.orderEscrow(orderId), amountMinor: amount }],
    });
    run(`UPDATE payment_intents SET status='succeeded',settlement='settled',settled_journal_id=?,order_id=?,failure_reason='',next_check_at=NULL,updated_at=? WHERE id=?`,
      journalId, orderId, now(), intent.id);
    notify(listing.seller_id, 'order', 'Nouvelle commande payée', `${listing.title} — ${money(amount, intent.base_currency)} en séquestre jusqu’à l’acceptation de la livraison.`, `/marketplace?view=orders&order=${orderId}`);
    notify(intent.user_id, 'payment', 'Paiement confirmé', `Votre commande « ${listing.title} » est enregistrée.`, `/marketplace?view=orders&order=${orderId}`);
    audit(intent.user_id, 'payments.order.paid', 'order', orderId, JSON.stringify({ intent_id: intent.id, amount_minor: amount, mode: intent.mode, source }));
    return { applied: true, orderId };
  });
}

/**
 * Pays an accepted mission of a sandbox/live campaign from its escrow (`mission.paid`, platform fee deducted)
 * and marks it paid. Idempotent per mission. Call inside the caller's transaction.
 */
export function payMissionFromEscrow(missionId: string, actorId: string) {
  return transaction(() => {
    const mission = one<{ id: string; status: string; tester_id: string; campaign_id: string; owner_id: string; reward_cents: number; title: string; payment_mode: PaymentMode }>(
      `SELECT m.id,m.status,m.tester_id,m.campaign_id,c.owner_id,c.reward_cents,c.title,c.payment_mode
       FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?`, missionId);
    if (!mission) throw new HttpError(404, 'Mission introuvable.');
    if (mission.payment_mode === 'demo') throw new HttpError(400, 'Mission de démonstration : utilisez le versement de démonstration.');
    const mode = mission.payment_mode;
    if (mission.owner_id !== actorId) throw new HttpError(403, 'Seul le responsable peut déclencher le versement.');
    if (mission.status === 'paid') return { status: 'paid' as const, mode };
    if (mission.status !== 'accepted') throw new HttpError(409, 'Le rapport doit être accepté avant le versement.');
    const escrow = ledgerAccounts.campaignEscrow(mission.campaign_id);
    const currency = ledgerCurrency(mode, escrow);
    if (!currency) throw new HttpError(409, 'Budget insuffisant.');
    const reward = mission.reward_cents;
    const fee = computeFee(reward, feeSettings().testing_fee_bps);
    if (balance(escrow, mode, currency) < reward) throw new HttpError(409, 'Budget insuffisant : le séquestre de la campagne ne couvre pas cette récompense.');
    postJournal({
      idempotencyKey: `mission.paid:${mission.id}`, kind: 'mission.paid', mode, currency, refType: 'mission', refId: mission.id,
      memo: `Récompense mission ${mission.id}`, actorId,
      legs: [
        { account: escrow, amountMinor: -reward },
        { account: ledgerAccounts.userAvailable(mission.tester_id), amountMinor: reward - fee },
        { account: ledgerAccounts.platformFees(), amountMinor: fee },
      ],
      nonNegative: [escrow],
    });
    run("UPDATE missions SET status='paid', updated_at=? WHERE id=?", now(), mission.id);
    notify(mission.tester_id, 'payment', 'Récompense créditée', `${money(reward - fee, currency)} crédités sur votre portefeuille (commission Alpha ${money(fee, currency)}).`, '/wallet');
    audit(actorId, 'payments.mission.paid', 'mission', mission.id, JSON.stringify({ amount_minor: reward, fee_minor: fee, mode }));
    return { status: 'paid' as const, mode };
  });
}

/** Buyer accepted the delivery: escrow -> seller available balance minus the marketplace fee (`order.released`). */
export function releaseOrderEscrow(orderId: string, actorId: string) {
  return transaction(() => {
    const order = one<{ id: string; seller_id: string; buyer_id: string; payment_mode: PaymentMode; listing_title: string }>(
      'SELECT o.id,o.seller_id,o.buyer_id,o.payment_mode,l.title AS listing_title FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.id=?', orderId);
    if (!order) throw new HttpError(404, 'Commande introuvable.');
    if (order.payment_mode === 'demo') throw new HttpError(400, 'Commande de démonstration : aucun séquestre réel.');
    const mode = order.payment_mode;
    const escrow = ledgerAccounts.orderEscrow(order.id);
    const currency = ledgerCurrency(mode, escrow);
    const amount = currency ? balance(escrow, mode, currency) : 0;
    if (!currency || amount <= 0) throw new HttpError(409, 'Aucun montant en séquestre pour cette commande.');
    const fee = computeFee(amount, feeSettings().marketplace_fee_bps);
    postJournal({
      idempotencyKey: `order.released:${order.id}`, kind: 'order.released', mode, currency, refType: 'order', refId: order.id,
      memo: `Libération commande ${order.id}`, actorId,
      legs: [
        { account: escrow, amountMinor: -amount },
        { account: ledgerAccounts.userAvailable(order.seller_id), amountMinor: amount - fee },
        { account: ledgerAccounts.platformFees(), amountMinor: fee },
      ],
      nonNegative: [escrow],
    });
    notify(order.seller_id, 'payment', 'Paiement libéré', `${money(amount - fee, currency)} crédités sur votre portefeuille pour « ${order.listing_title} » (commission ${money(fee, currency)}).`, '/wallet');
    audit(actorId, 'payments.order.released', 'order', order.id, JSON.stringify({ amount_minor: amount, fee_minor: fee, mode }));
    return { amount_minor: amount, fee_minor: fee, currency, mode };
  });
}

/**
 * Call INSIDE the caller's transaction. Moves the remaining order escrow back to the buyer (ledger journal,
 * idempotent per order) and schedules the provider refund after commit. Throws HttpError(409) when nothing
 * can be refunded (already released/refunded) and HttpError(400) for demo orders.
 */
export function refundOrderEscrow(orderId: string, actorId: string, reason: string): void {
  transaction(() => {
    const order = one<{ id: string; buyer_id: string; seller_id: string; payment_mode: PaymentMode; listing_title: string }>(
      'SELECT o.id,o.buyer_id,o.seller_id,o.payment_mode,l.title AS listing_title FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.id=?', orderId);
    if (!order) throw new HttpError(404, 'Commande introuvable.');
    if (order.payment_mode === 'demo') throw new HttpError(400, 'Commande de démonstration : aucun séquestre réel à rembourser.');
    const mode = order.payment_mode;
    const escrow = ledgerAccounts.orderEscrow(order.id);
    const currency = ledgerCurrency(mode, escrow);
    const amount = currency ? balance(escrow, mode, currency) : 0;
    if (!currency || amount <= 0) throw new HttpError(409, 'Aucun montant remboursable : le séquestre a déjà été libéré ou remboursé.');
    const intent = one<IntentRow>("SELECT * FROM payment_intents WHERE order_id=? AND settlement='settled' ORDER BY created_at LIMIT 1", order.id);
    if (!intent) throw new HttpError(409, 'Paiement d’origine introuvable pour cette commande.');
    const { journalId } = postJournal({
      idempotencyKey: `order.refunded:${order.id}`, kind: 'order.refunded', mode, currency, refType: 'order', refId: order.id,
      memo: reason.slice(0, 500) || `Remboursement commande ${order.id}`, actorId,
      legs: [{ account: escrow, amountMinor: -amount }, { account: ledgerAccounts.provider(intent.provider), amountMinor: amount }],
      nonNegative: [escrow],
    });
    createRefund({ intent, amountBaseMinor: amount, reason, requestedBy: actorId, orderId: order.id, journalId });
    run("UPDATE orders SET status='refunded',version=version+1 WHERE id=?", order.id);
    notify(order.buyer_id, 'payment', 'Remboursement en cours', `${money(amount, currency)} vont être remboursés pour « ${order.listing_title} ».`, `/marketplace?view=orders&order=${order.id}`);
    notify(order.seller_id, 'order', 'Commande remboursée', `La commande « ${order.listing_title} » a été remboursée à l’acheteur.`, `/marketplace?view=orders&order=${order.id}`);
    audit(actorId, 'payments.order.refunded', 'order', order.id, JSON.stringify({ amount_minor: amount, mode, reason: reason.slice(0, 300) }));
  });
}

/**
 * Owner action on a closed sandbox/live campaign: refunds the UNRESERVED escrow (missions in progress keep their
 * reward) across the funding payments, newest first (`campaign.refunded`). Call inside the caller's transaction.
 */
export function refundCampaignEscrow(campaignId: string, actorId: string, reason: string) {
  return transaction(() => {
    const campaign = campaignMoneyRow(campaignId);
    if (!campaign) throw new HttpError(404, 'Campagne introuvable.');
    if (campaign.owner_id !== actorId) throw new HttpError(403, 'Seul le responsable peut demander ce remboursement.');
    if (campaign.payment_mode === 'demo') throw new HttpError(400, 'Campagne de démonstration : aucun séquestre réel à rembourser.');
    if (campaign.status !== 'closed') throw new HttpError(409, 'Fermez la campagne avant de demander le remboursement du solde non engagé.');
    const mode = campaign.payment_mode;
    const escrow = ledgerAccounts.campaignEscrow(campaign.id);
    const currency = ledgerCurrency(mode, escrow);
    const refundable = currency ? balance(escrow, mode, currency) - reservedCents(campaign.id) : 0;
    if (!currency || refundable <= 0) throw new HttpError(409, 'Aucun montant non engagé à rembourser.');
    const intents = all<IntentRow>(`SELECT * FROM payment_intents WHERE purpose='campaign_funding' AND ref_id=? AND settlement='settled' AND mode=?
      ORDER BY created_at DESC`, campaign.id, mode);
    const plan: { intent: IntentRow; amount: number }[] = [];
    let left = refundable;
    for (const intent of intents) {
      if (left <= 0) break;
      const amount = Math.min(left, intent.amount_base_minor - refundedBaseForIntent(intent.id));
      if (amount > 0) { plan.push({ intent, amount }); left -= amount; }
    }
    if (left > 0) throw new HttpError(409, 'Le montant à rembourser dépasse les paiements d’origine : contactez l’administration.');
    const previous = one<{ total: number }>("SELECT COUNT(*) AS total FROM ledger_journals WHERE kind='campaign.refunded' AND ref_id=?", campaign.id)!.total;
    const { journalId } = postJournal({
      idempotencyKey: previous ? `campaign.refunded:${campaign.id}:${previous + 1}` : `campaign.refunded:${campaign.id}`,
      kind: 'campaign.refunded', mode, currency, refType: 'campaign', refId: campaign.id,
      memo: reason.slice(0, 500) || `Remboursement du solde de la campagne ${campaign.id}`, actorId,
      legs: [
        { account: escrow, amountMinor: -refundable },
        ...plan.map(({ intent, amount }) => ({ account: ledgerAccounts.provider(intent.provider), amountMinor: amount })),
      ],
      nonNegative: [escrow],
    });
    for (const { intent, amount } of plan) {
      createRefund({ intent, amountBaseMinor: amount, reason: reason || 'Solde de campagne non utilisé', requestedBy: actorId, campaignId: campaign.id, journalId });
    }
    notify(campaign.owner_id, 'payment', 'Remboursement du séquestre en cours', `${money(refundable, currency)} non engagés sur « ${campaign.title} » vont vous être remboursés.`, '/payments');
    audit(actorId, 'payments.campaign.refunded', 'campaign', campaign.id, JSON.stringify({ amount_minor: refundable, mode }));
    return { refunded_cents: refundable, currency, mode };
  });
}
