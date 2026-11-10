import { one } from '../db.js';
import { HttpError } from '../core.js';
import * as payments from '../payments/escrow.js';
import type { PaymentMode } from '../payments/mode.js';

/** Escrow operations used by dispute resolution (contract owned by payments-core). Swappable in tests only. */
export interface EscrowAdapter {
  orderPaymentMode(orderId: string): PaymentMode;
  refundOrderEscrow(orderId: string, actorId: string, reason: string): void;
}

const defaultAdapter: EscrowAdapter = {
  orderPaymentMode: (orderId) => payments.orderPaymentMode(orderId),
  refundOrderEscrow: (orderId, actorId, reason) => payments.refundOrderEscrow(orderId, actorId, reason),
};
let adapter = defaultAdapter;

export const escrow: EscrowAdapter = {
  orderPaymentMode: (orderId) => adapter.orderPaymentMode(orderId),
  refundOrderEscrow: (orderId, actorId, reason) => adapter.refundOrderEscrow(orderId, actorId, reason),
};

export function setEscrowAdapterForTests(next: EscrowAdapter | null) {
  if (process.env.NODE_ENV === 'production') throw new Error('Adaptateur de séquestre de test interdit en production.');
  adapter = next ?? defaultAdapter;
}

let refundedKind: boolean | null = null;
/** Whether `order_events.kind` accepts 'refunded' (otherwise the refund is journaled as a moderation 'resumed' event). */
export function orderEventsAcceptRefunded(): boolean {
  if (refundedKind === null) {
    const sql = one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_events'")?.sql ?? '';
    refundedKind = sql.includes("'refunded'");
  }
  return refundedKind;
}

/** Real (sandbox/live) escrow refund decided by moderation. Must run inside the resolution transaction. */
export function refundDisputedOrder(orderId: string, adminId: string, reason: string): PaymentMode {
  const mode = escrow.orderPaymentMode(orderId);
  if (mode === 'demo') {
    throw new HttpError(400, 'Commande de démonstration : aucun séquestre réel à rembourser. Reprenez-la à l’état payée ou livrée.');
  }
  escrow.refundOrderEscrow(orderId, adminId, reason);
  return mode;
}
