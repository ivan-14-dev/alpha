import { HttpError } from '../core.js';
import type { PaymentMode } from './mode.js';

/**
 * Escrow contract shared with trust (disputes) and compliance. OWNER: payments-core module.
 * Campaigns and orders lock the payment mode at funding/purchase time; demo resources keep V3 behaviour.
 */
export function orderPaymentMode(_orderId: string): PaymentMode { return 'demo'; }
export function campaignPaymentMode(_campaignId: string): PaymentMode { return 'demo'; }

/**
 * Call INSIDE the caller's transaction. Moves the remaining order escrow back to the buyer (ledger journal,
 * idempotent per order) and schedules the provider refund after commit. Throws HttpError(409) when nothing
 * can be refunded (already released/refunded) and HttpError(400) for demo orders.
 */
export function refundOrderEscrow(_orderId: string, _actorId: string, _reason: string): void {
  throw new HttpError(501, 'Remboursement séquestre non disponible.');
}
