import { z } from 'zod';
import { getSetting } from '../platform/settings.js';

/**
 * Global payment mode.
 *  - demo: V1-V3 behaviour, simulated `transactions`, no provider (default).
 *  - sandbox: provider sandboxes / Alpha simulator, balanced ledger, no real money.
 *  - live: real providers. Requires admin confirmation, HTTPS APP_ORIGIN, ALPHA_SECRETS_KEY and legal review.
 */
export type PaymentMode = 'demo' | 'sandbox' | 'live';
export type LedgerMode = Exclude<PaymentMode, 'demo'>;
export const PAYMENT_MODE_SETTING = 'payments.mode';
export const BASE_CURRENCY_SETTING = 'payments.base_currency';
export const FX_SETTING = 'payments.fx';

export function paymentMode(): PaymentMode {
  return getSetting<PaymentMode>(PAYMENT_MODE_SETTING, z.enum(['demo', 'sandbox', 'live']), 'demo');
}

export const currencyExponent: Record<string, number> = {
  EUR: 2, USD: 2, GBP: 2, CAD: 2, CHF: 2, ZAR: 2, NGN: 2, GHS: 2, KES: 2, MAD: 2, TND: 3,
  XAF: 0, XOF: 0, UGX: 0, RWF: 0, GNF: 0, CDF: 2, TZS: 2,
};

export function exponent(currency: string): number {
  const value = currencyExponent[currency];
  if (value === undefined) throw new Error(`Devise non prise en charge: ${currency}`);
  return value;
}

export function baseCurrency(): string {
  return getSetting(BASE_CURRENCY_SETTING, z.string().regex(/^[A-Z]{3}$/), 'EUR');
}

/** Units of `currency` for ONE unit of the base currency. XAF/XOF are pegged to EUR at 655.957. */
export function fxRates(): Record<string, number> {
  const defaults: Record<string, number> = { EUR: 1, XAF: 655.957, XOF: 655.957 };
  return { ...defaults, ...getSetting(FX_SETTING, z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive().max(1e7)), {}) };
}

function rate(currency: string): number {
  if (currency === baseCurrency()) return 1;
  const value = fxRates()[currency];
  if (!value) throw new Error(`Aucun taux de change configure pour ${currency}.`);
  return value;
}

/** Base minor units -> provider currency minor units, rounded UP so the platform never under-collects. */
export function fromBase(amountBaseMinor: number, currency: string): number {
  const base = baseCurrency();
  const major = amountBaseMinor / 10 ** exponent(base);
  return Math.ceil(major * rate(currency) * 10 ** exponent(currency) - 1e-9);
}

/** Provider currency minor units -> base minor units, rounded DOWN so the platform never over-credits. */
export function toBase(amountMinor: number, currency: string): number {
  const base = baseCurrency();
  const major = amountMinor / 10 ** exponent(currency);
  return Math.floor((major / rate(currency)) * 10 ** exponent(base) + 1e-9);
}
