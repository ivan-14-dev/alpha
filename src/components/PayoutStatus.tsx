import { useState } from 'react';
import { Badge } from './ui';

/* Shared compliance types, labels and money-input helpers (wallet page and admin console). OWNER: compliance module. */

export type WithdrawalStatus = 'requested' | 'on_hold' | 'approved' | 'processing' | 'paid' | 'failed' | 'rejected' | 'cancelled';
export type PayoutKind = 'mobile_money' | 'bank_account' | 'stripe_connect';
export type PaymentMode = 'demo' | 'sandbox' | 'live';

export interface PayoutMethodView {
  id: string; kind: PayoutKind; provider: string | null; label: string; display_mask: string;
  country: string; currency: string; is_default: boolean; verified_at: string | null; deleted_at: string | null;
  created_at: string; payout_available?: boolean;
}

export interface WithdrawalView {
  id: string; status: WithdrawalStatus; mode: 'sandbox' | 'live';
  amount_base_minor: number; base_currency: string; amount_minor: number; currency: string;
  provider: string; method: { id: string; kind: PayoutKind; display_mask: string; label: string } | null;
  review_note: string; failure_reason: string; attempts: number; next_attempt_at: string | null;
  created_at: string; updated_at: string; paid_at: string | null; closed_at: string | null; can_cancel: boolean;
}

export interface InvoiceView {
  id: string; number: string; kind: 'receipt' | 'commission' | 'payout_statement'; kind_label: string; series: string;
  currency: string; amount_net_minor: number; amount_tax_minor: number; amount_gross_minor: number; tax_rate_bps: number;
  description: string; ref_type: string; ref_id: string; issued_at: string; html_url: string;
}

export const withdrawalStatusLabels: Record<WithdrawalStatus, string> = {
  requested: 'Demandé',
  on_hold: 'En vérification',
  approved: 'Approuvé',
  processing: 'Versement en cours',
  paid: 'Versé',
  failed: 'Échoué',
  rejected: 'Refusé',
  cancelled: 'Annulé',
};

const withdrawalTones: Record<WithdrawalStatus, string> = {
  requested: 'neutral', on_hold: 'orange', approved: 'blue', processing: 'purple', paid: 'green', failed: 'red', rejected: 'red', cancelled: 'neutral',
};

export function WithdrawalStatusBadge({ status }: { status: WithdrawalStatus }) {
  return <Badge tone={withdrawalTones[status] ?? 'neutral'}>{withdrawalStatusLabels[status] ?? status}</Badge>;
}

export const payoutKindLabels: Record<PayoutKind, string> = {
  mobile_money: 'Mobile money',
  bank_account: 'Compte bancaire',
  stripe_connect: 'Stripe Connect',
};

export const modeLabels: Record<PaymentMode, string> = { demo: 'Démonstration', sandbox: 'Bac à sable', live: 'Réel' };

/** Countries proposed first in the forms (CEMAC, UEMOA, EU...); any other ISO 3166-1 alpha-2 code can be typed. */
export const countries: { code: string; name: string; currency: string }[] = [
  { code: 'CM', name: 'Cameroun', currency: 'XAF' }, { code: 'GA', name: 'Gabon', currency: 'XAF' }, { code: 'CG', name: 'Congo', currency: 'XAF' },
  { code: 'TD', name: 'Tchad', currency: 'XAF' }, { code: 'CF', name: 'Centrafrique', currency: 'XAF' }, { code: 'GQ', name: 'Guinée équatoriale', currency: 'XAF' },
  { code: 'SN', name: 'Sénégal', currency: 'XOF' }, { code: 'CI', name: 'Côte d’Ivoire', currency: 'XOF' }, { code: 'BJ', name: 'Bénin', currency: 'XOF' },
  { code: 'BF', name: 'Burkina Faso', currency: 'XOF' }, { code: 'ML', name: 'Mali', currency: 'XOF' }, { code: 'NE', name: 'Niger', currency: 'XOF' },
  { code: 'TG', name: 'Togo', currency: 'XOF' }, { code: 'GN', name: 'Guinée', currency: 'GNF' }, { code: 'CD', name: 'RD Congo', currency: 'CDF' },
  { code: 'MA', name: 'Maroc', currency: 'MAD' }, { code: 'TN', name: 'Tunisie', currency: 'TND' }, { code: 'NG', name: 'Nigeria', currency: 'NGN' },
  { code: 'GH', name: 'Ghana', currency: 'GHS' }, { code: 'KE', name: 'Kenya', currency: 'KES' }, { code: 'FR', name: 'France', currency: 'EUR' },
  { code: 'BE', name: 'Belgique', currency: 'EUR' }, { code: 'LU', name: 'Luxembourg', currency: 'EUR' }, { code: 'DE', name: 'Allemagne', currency: 'EUR' },
  { code: 'ES', name: 'Espagne', currency: 'EUR' }, { code: 'IT', name: 'Italie', currency: 'EUR' }, { code: 'CH', name: 'Suisse', currency: 'CHF' },
  { code: 'GB', name: 'Royaume-Uni', currency: 'GBP' }, { code: 'CA', name: 'Canada', currency: 'CAD' }, { code: 'US', name: 'États-Unis', currency: 'USD' },
];

export const countryName = (code: string | null | undefined) => (code ? countries.find((country) => country.code === code)?.name ?? code : '—');
export const currencyFor = (code: string) => countries.find((country) => country.code === code)?.currency ?? 'EUR';

/** Country picker: the usual countries, or any ISO alpha-2 code typed by hand. */
export function CountryField({ id, label, value, onChange, required, disabled }: {
  id: string; label: string; value: string; onChange: (code: string) => void; required?: boolean; disabled?: boolean;
}) {
  const listed = countries.some((country) => country.code === value);
  const [other, setOther] = useState(!!value && !listed);
  const manual = other || (!!value && !listed);
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={manual ? 'other' : value} required={required} disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        setOther(next === 'other');
        onChange(next === 'other' ? '' : next);
      }}>
      <option value="">Choisir un pays…</option>
      {countries.map((country) => <option key={country.code} value={country.code}>{country.name} ({country.code})</option>)}
      <option value="other">Autre pays (code ISO)…</option>
    </select>
    {manual && <input aria-label={`${label} : code ISO à deux lettres`} value={value} maxLength={2} pattern="[A-Za-z]{2}" required={required}
      disabled={disabled} placeholder="Code ISO, ex. RW" autoComplete="off" onChange={(event) => onChange(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />}
  </div>;
}

/** Number of decimals of a currency according to Intl (0 for XAF/XOF, 2 for EUR). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Parses an amount typed in major units ("12,50") into integer minor units; null when invalid. */
export function toMinor(value: string, currency: string): number | null {
  const normalized = value.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const digits = currencyDigits(currency);
  const [, decimals = ''] = normalized.split('.');
  if (decimals.length > digits) return null;
  const minor = Math.round(Number(normalized) * 10 ** digits);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Integer minor units to an editable major-unit string ("1250" EUR -> "12,50"). */
export function toMajorInput(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (!digits) return String(minor);
  return (minor / 10 ** digits).toFixed(digits).replace('.', ',');
}

export const percentFromBps = (bps: number) => `${(bps / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;

/** Random idempotency key so a double click or a retried request never creates two withdrawals. */
export function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `wd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}
