import { all, one } from '../../db.js';
import { notify } from '../../core.js';
import { exponent } from '../mode.js';
import type { LedgerMode } from '../mode.js';

export type IntentStatus = 'created' | 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export type IntentPurpose = 'campaign_funding' | 'order_purchase';
export const OPEN_INTENT_STATUSES: IntentStatus[] = ['created', 'pending'];

export interface IntentRow {
  id: string;
  user_id: string;
  purpose: IntentPurpose;
  ref_type: 'campaign' | 'listing';
  ref_id: string;
  order_id: string | null;
  mode: LedgerMode;
  provider: string;
  method: string | null;
  operator: string | null;
  provider_reference: string | null;
  amount_base_minor: number;
  base_currency: string;
  amount_minor: number;
  currency: string;
  fx_rate: number;
  status: IntentStatus;
  failure_reason: string;
  settlement: 'none' | 'settled' | 'unapplied';
  review_required: number;
  idempotency_key: string;
  redirect_url: string | null;
  instructions: string;
  customer_phone_masked: string;
  settled_journal_id: string | null;
  attempts: number;
  next_check_at: string | null;
  last_checked_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface RefundRow {
  id: string;
  intent_id: string;
  order_id: string | null;
  campaign_id: string | null;
  journal_id: string | null;
  mode: LedgerMode;
  provider: string;
  amount_base_minor: number;
  base_currency: string;
  amount_minor: number;
  currency: string;
  reason: string;
  provider_reference: string | null;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  attempts: number;
  last_error: string;
  next_attempt_at: string | null;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
}

export function getIntent(intentId: string): IntentRow | undefined {
  return one<IntentRow>('SELECT * FROM payment_intents WHERE id=?', intentId);
}

export function getRefund(refundId: string): RefundRow | undefined {
  return one<RefundRow>('SELECT * FROM refunds WHERE id=?', refundId);
}

export function isoIn(ms: number): string { return new Date(Date.now() + ms).toISOString(); }

/** Exponential backoff for provider re-checks: 1 min, 2 min, 4 min ... capped at 1 hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(Math.max(attempts, 0), 6));
}

/** Only a masked phone number is ever stored or displayed (+237•••••89). */
export function maskPhone(phone: string | undefined | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 5) return '•'.repeat(digits.length);
  return `+${digits.slice(0, 3)}${'•'.repeat(digits.length - 5)}${digits.slice(-2)}`;
}

/** Provider messages may echo request data: keep them short and strip anything resembling a phone, email or token. */
export function safeReason(value: unknown, fallback = ''): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
  return (text || fallback)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[numéro]')
    .replace(/\b(sk|pk|rk|whsec|FLWSECK|Bearer)[_-]?[A-Za-z0-9_\-.]{6,}/g, '[secret]')
    .slice(0, 300);
}

export function formatMoney(amountMinor: number, currency: string): string {
  const digits = exponent(currency);
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits })
      .format(amountMinor / 10 ** digits);
  } catch {
    return `${(amountMinor / 10 ** digits).toFixed(digits)} ${currency}`;
  }
}

export function intentTitle(intent: Pick<IntentRow, 'purpose' | 'ref_id'>): string {
  if (intent.purpose === 'campaign_funding') {
    const campaign = one<{ title: string }>('SELECT title FROM campaigns WHERE id=?', intent.ref_id);
    return campaign ? `Financement · ${campaign.title}` : 'Financement de campagne';
  }
  const listing = one<{ title: string }>('SELECT title FROM listings WHERE id=?', intent.ref_id);
  return listing ? `Achat · ${listing.title}` : 'Achat marketplace';
}

/** Member-safe projection (no idempotency key, no attempt counters). */
export function publicIntent(intent: IntentRow) {
  return {
    id: intent.id,
    purpose: intent.purpose,
    ref_type: intent.ref_type,
    ref_id: intent.ref_id,
    order_id: intent.order_id,
    title: intentTitle(intent),
    mode: intent.mode,
    provider: intent.provider,
    method: intent.method,
    operator: intent.operator,
    provider_reference: intent.provider_reference,
    amount_base_minor: intent.amount_base_minor,
    base_currency: intent.base_currency,
    amount_minor: intent.amount_minor,
    currency: intent.currency,
    status: intent.status,
    failure_reason: intent.failure_reason,
    settlement: intent.settlement,
    review_required: !!intent.review_required,
    redirect_url: intent.redirect_url,
    instructions: intent.instructions,
    customer_phone_masked: intent.customer_phone_masked,
    expires_at: intent.expires_at,
    created_at: intent.created_at,
    updated_at: intent.updated_at,
    final: !['created', 'pending'].includes(intent.status),
  };
}

export function adminIntent(intent: IntentRow) {
  const payer = one<{ name: string; email: string }>('SELECT name,email FROM users WHERE id=?', intent.user_id);
  return {
    ...publicIntent(intent),
    user_id: intent.user_id,
    payer_name: payer?.name ?? '',
    payer_email: payer?.email ?? '',
    fx_rate: intent.fx_rate,
    attempts: intent.attempts,
    next_check_at: intent.next_check_at,
    last_checked_at: intent.last_checked_at,
    settled_journal_id: intent.settled_journal_id,
  };
}

/** In-app alert to every administrator (amount mismatch, refund failure...). Call inside the caller's transaction. */
export function alertAdmins(title: string, body: string, link = '/admin/payments') {
  for (const admin of all<{ id: string }>("SELECT id FROM users WHERE role='admin'")) {
    notify(admin.id, 'payments_alert', title, body, link);
  }
}
