import { z } from 'zod';
import { getSetting } from '../platform/settings.js';

/** Erasure grace period: the account keeps working and the request can be cancelled until then. */
export const ERASURE_GRACE_DAYS = 30;
/** An export link stays downloadable this long after it became ready. */
export const EXPORT_VALIDITY_DAYS = 7;
/** One export request per user per window. */
export const EXPORT_RATE_WINDOW_MS = 24 * 3600000;
/** Accounts without a verifiable password must have signed in this recently to request erasure. */
export const FRESH_LOGIN_MS = 10 * 60000;
/** Art. 12.3: answer within one month (extendable by two months for complex requests). */
export const RESPONSE_DEADLINE_DAYS = 30;
/** Art. 33.1: notify the supervisory authority within 72 hours of becoming aware of a breach. */
export const BREACH_NOTIFICATION_HOURS = 72;
export const DAY_MS = 86400000;

export const CONTROLLER_SETTING = 'privacy.controller';
export const RETENTION_SETTING = 'privacy.retention';

const text = (max: number) => z.string().trim().max(max).default('');
const emailOrEmpty = z.union([z.literal(''), z.string().trim().email().max(254)]).default('');

/** Identity of the data controller, injected into the legal templates (placeholders `{{key}}`). */
export const controllerSchema = z.object({
  company_name: text(160),
  legal_form: text(120),
  share_capital: text(80),
  address: text(400),
  registration: text(200),
  vat_number: text(60),
  email: emailOrEmpty,
  phone: text(40),
  dpo_email: emailOrEmpty,
  director: text(160),
  host_name: text(160),
  host_address: text(400),
}).strict();
export type ControllerIdentity = z.infer<typeof controllerSchema>;
export const emptyController: ControllerIdentity = controllerSchema.parse({});

export const controllerLabels: Record<keyof ControllerIdentity, string> = {
  company_name: 'raison sociale',
  legal_form: 'forme juridique',
  share_capital: 'capital social',
  address: 'adresse du siège',
  registration: 'immatriculation (RCS/SIREN)',
  vat_number: 'numéro de TVA intracommunautaire',
  email: 'e-mail de contact',
  phone: 'téléphone',
  dpo_email: 'e-mail du délégué à la protection des données',
  director: 'directeur de la publication',
  host_name: 'hébergeur',
  host_address: 'adresse de l’hébergeur',
};

export function controllerIdentity(): ControllerIdentity {
  return getSetting(CONTROLLER_SETTING, controllerSchema, emptyController);
}

/** Default long-retention audit prefixes: money, trust and privacy evidence (statute of limitations, accounting). */
export const defaultLongAuditPrefixes = [
  'payment', 'payments', 'ledger', 'escrow', 'wallet', 'withdrawal', 'payout', 'refund', 'invoice', 'tax',
  'order', 'mission', 'campaign', 'compliance', 'kyc', 'trust', 'sanction', 'appeal', 'moderation', 'risk', 'privacy', 'admin',
];

export const retentionSchema = z.object({
  enabled: z.boolean().default(true),
  notifications_read_days: z.number().int().min(30).max(3650).default(365),
  email_sent_days: z.number().int().min(7).max(3650).default(90),
  email_failed_days: z.number().int().min(7).max(3650).default(180),
  audit_days: z.number().int().min(365).max(3650).default(1095),
  audit_long_days: z.number().int().min(1095).max(7300).default(3650),
  audit_long_prefixes: z.array(z.string().trim().regex(/^[a-z][a-z0-9_-]{1,40}$/)).max(60).default(defaultLongAuditPrefixes),
  risk_signals_days: z.number().int().min(30).max(3650).default(180),
  privacy_requests_days: z.number().int().min(365).max(3650).default(1095),
}).strict().refine((value) => value.audit_long_days >= value.audit_days, {
  message: 'La conservation longue des journaux doit être supérieure ou égale à la conservation standard.',
  path: ['audit_long_days'],
});
export type RetentionSettings = z.infer<typeof retentionSchema>;
export const defaultRetention: RetentionSettings = retentionSchema.parse({});

export function retentionSettings(): RetentionSettings {
  return getSetting(RETENTION_SETTING, retentionSchema, defaultRetention);
}

export const daysAgo = (days: number, from = Date.now()) => new Date(from - days * DAY_MS).toISOString();
export const daysAhead = (days: number, from = Date.now()) => new Date(from + days * DAY_MS).toISOString();
