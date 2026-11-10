import { z } from 'zod';
import { getSetting, setSetting, settingUpdatedAt } from '../platform/settings.js';

/**
 * Admin-editable compliance settings (namespace `compliance.*`). Amounts are in BASE currency minor units
 * (see payments.base_currency), rates in basis points (2000 = 20 %).
 */
const amount = z.number().int().min(0).max(1e12);

export const limitsSchema = z.object({
  /** Identity verification required when the withdrawal plus the last 30 days of withdrawals exceed this amount. */
  kyc_required_above_minor: amount,
  min_withdrawal_minor: amount,
  /** Rolling 24 hours. */
  daily_limit_minor: amount,
  /** Rolling 30 days. */
  monthly_limit_minor: amount,
  /** Withdrawals above this amount are held for manual review. */
  manual_review_above_minor: amount,
}).strict()
  .refine((value) => value.min_withdrawal_minor <= value.daily_limit_minor, { message: 'Le minimum doit être inférieur au plafond journalier.', path: ['min_withdrawal_minor'] })
  .refine((value) => value.daily_limit_minor <= value.monthly_limit_minor, { message: 'Le plafond journalier doit être inférieur au plafond mensuel.', path: ['daily_limit_minor'] });
export type ComplianceLimits = z.infer<typeof limitsSchema>;
export const defaultLimits: ComplianceLimits = {
  kyc_required_above_minor: 15000,
  min_withdrawal_minor: 1000,
  daily_limit_minor: 100000,
  monthly_limit_minor: 500000,
  manual_review_above_minor: 50000,
};

export const payoutRetrySchema = z.object({
  /** Provider attempts before the withdrawal fails and funds return to the user's balance. */
  max_attempts: z.number().int().min(1).max(10),
  /** Delay before the 2nd attempt; doubles at each attempt (capped at 24 h). */
  base_delay_seconds: z.number().int().min(1).max(86400),
  /** How often a pending provider payout is re-checked. */
  status_check_seconds: z.number().int().min(10).max(86400),
}).strict();
export type PayoutRetry = z.infer<typeof payoutRetrySchema>;
export const defaultPayoutRetry: PayoutRetry = { max_attempts: 4, base_delay_seconds: 300, status_check_seconds: 300 };

const country = z.string().regex(/^[A-Z]{2}$/);
export const taxSchema = z.object({
  default_rate_bps: z.number().int().min(0).max(10000),
  /** Per customer country (ISO 3166-1 alpha-2). */
  rates: z.record(country, z.number().int().min(0).max(10000)).refine((value) => Object.keys(value).length <= 300, 'Trop de pays.'),
  /** true: the platform fee retained is VAT inclusive (TTC); false: the fee is net (HT) and VAT is added on top. */
  prices_include_tax: z.boolean(),
  /** Printed on commission invoices when the rate is 0 (e.g. "TVA non applicable, art. 293 B du CGI" or reverse charge). */
  exemption_mention: z.string().trim().max(300),
}).strict();
export type TaxSettings = z.infer<typeof taxSchema>;
export const defaultTax: TaxSettings = { default_rate_bps: 2000, rates: {}, prices_include_tax: true, exemption_mention: '' };

export const issuerSchema = z.object({
  legal_name: z.string().trim().max(160),
  /** Multi-line postal address. */
  address: z.string().trim().max(500),
  /** SIREN/SIRET + RCS (France) or RCCM (OHADA). */
  registration_number: z.string().trim().max(120),
  vat_number: z.string().trim().max(40),
  /** Share capital / legal form, e.g. "SAS au capital de 1 000 €". */
  legal_form: z.string().trim().max(160),
  email: z.union([z.literal(''), z.string().trim().email().max(254)]),
  /** Legal mentions printed at the bottom of every document (penalties, recovery fee, mediator...). */
  footer: z.string().trim().max(2000),
}).strict();
export type IssuerSettings = z.infer<typeof issuerSchema>;
export const defaultIssuer: IssuerSettings = { legal_name: '', address: '', registration_number: '', vat_number: '', legal_form: '', email: '', footer: '' };

export const LIMITS_SETTING = 'compliance.limits';
export const PAYOUT_RETRY_SETTING = 'compliance.payout_retry';
export const TAX_SETTING = 'compliance.tax';
export const ISSUER_SETTING = 'compliance.issuer';

export const complianceLimits = () => getSetting(LIMITS_SETTING, limitsSchema, defaultLimits);
export const payoutRetry = () => getSetting(PAYOUT_RETRY_SETTING, payoutRetrySchema, defaultPayoutRetry);
export const taxSettings = () => getSetting(TAX_SETTING, taxSchema, defaultTax);
export const issuerSettings = () => getSetting(ISSUER_SETTING, issuerSchema, defaultIssuer);

/** Live invoices are only issued once the mandatory issuer identity is complete. */
export function issuerProblems(issuer: IssuerSettings = issuerSettings()): string[] {
  const problems: string[] = [];
  if (!issuer.legal_name) problems.push('Raison sociale de l’émetteur manquante.');
  if (!issuer.address) problems.push('Adresse de l’émetteur manquante.');
  if (!issuer.registration_number) problems.push('Numéro d’immatriculation (SIREN/RCS ou RCCM) manquant.');
  return problems;
}

export function describeSettings() {
  return {
    limits: { value: complianceLimits(), updated_at: settingUpdatedAt(LIMITS_SETTING) },
    payout_retry: { value: payoutRetry(), updated_at: settingUpdatedAt(PAYOUT_RETRY_SETTING) },
    tax: { value: taxSettings(), updated_at: settingUpdatedAt(TAX_SETTING) },
    issuer: { value: issuerSettings(), updated_at: settingUpdatedAt(ISSUER_SETTING), problems: issuerProblems() },
  };
}

export const settingDefinitions = {
  limits: { key: LIMITS_SETTING, schema: limitsSchema },
  payout_retry: { key: PAYOUT_RETRY_SETTING, schema: payoutRetrySchema },
  tax: { key: TAX_SETTING, schema: taxSchema },
  issuer: { key: ISSUER_SETTING, schema: issuerSchema },
} as const;
export type SettingName = keyof typeof settingDefinitions;

export function saveSetting(name: SettingName, value: unknown, actorId: string) {
  const parsed = settingDefinitions[name].schema.parse(value);
  setSetting(settingDefinitions[name].key, parsed, actorId);
  return parsed;
}
