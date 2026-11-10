import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { HttpError, id, notify, now } from '../core.js';
import { activeEnvironment, enabledProviders } from '../payments/config.js';
import { currencyExponent, payoutFromBase } from '../payments/mode.js';
import { getProvider } from '../payments/providers/index.js';
import type { PaymentProvider, PayoutRecipient } from '../payments/providers/types.js';
import { queueEmail, renderEmail } from '../platform/mailer.js';
import { keyedHash, seal, unseal } from '../platform/secrets.js';
import { isoCountry } from './util.js';

export type PayoutKind = 'mobile_money' | 'bank_account' | 'stripe_connect';
const MAX_METHODS = 10;

export const mobileOperators = ['mtn', 'orange', 'moov', 'wave', 'airtel', 'free', 'mpesa', 'vodacom', 'tigo', 'expresso', 'tmoney', 'flooz'] as const;
const operatorLabels: Record<string, string> = {
  mtn: 'MTN MoMo', orange: 'Orange Money', moov: 'Moov Money', wave: 'Wave', airtel: 'Airtel Money', free: 'Free Money',
  mpesa: 'M-Pesa', vodacom: 'Vodacom', tigo: 'Tigo Pesa', expresso: 'E-Money', tmoney: 'T-Money', flooz: 'Flooz',
};

export interface PayoutMethodRow {
  id: string;
  user_id: string;
  kind: PayoutKind;
  provider: string | null;
  label: string;
  details_sealed: string;
  display_mask: string;
  fingerprint: string;
  country: string;
  currency: string;
  is_default: number;
  verified_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** IBAN checksum (ISO 13616, mod 97). */
export function validIban(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (char) => String(char.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

const e164 = z.string().trim().transform((value) => value.replace(/[\s.()-]/g, '')).pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Numéro au format international attendu (ex. +237 6 70 00 00 00).'));
const holder = z.string().trim().min(2).max(120);

const mobileDetails = z.object({ phone: e164, operator: z.enum(mobileOperators), account_name: holder }).strict();
const bankDetails = z.object({
  account_holder: holder,
  iban: z.string().trim().transform((value) => value.replace(/\s+/g, '').toUpperCase()).pipe(z.string().refine(validIban, 'IBAN invalide.')).optional(),
  bic: z.string().trim().toUpperCase().regex(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'BIC invalide.').optional(),
  account_number: z.string().trim().transform((value) => value.replace(/[\s-]+/g, '').toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{6,34}$/, 'Numéro de compte invalide.')).optional(),
  bank_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,11}$/, 'Code banque invalide.').optional(),
  bank_name: z.string().trim().max(120).optional(),
}).strict().refine((value) => !!value.iban || (!!value.account_number && !!value.bank_code), 'Indiquez un IBAN, ou un numéro de compte et un code banque.');
const stripeDetails = z.object({ account_id: z.string().trim().regex(/^acct_[A-Za-z0-9]{6,64}$/, 'Identifiant de compte Stripe Connect invalide (acct_…).') }).strict();

const common = {
  label: z.string().trim().max(80).default(''),
  country: z.string().trim().toUpperCase().regex(isoCountry, 'Code pays ISO à deux lettres attendu.'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  provider: z.string().trim().min(2).max(40).regex(/^[a-z0-9_]+$/).nullable().optional(),
  make_default: z.boolean().default(false),
};
export const createPayoutMethodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mobile_money'), details: mobileDetails, ...common }).strict(),
  z.object({ kind: z.literal('bank_account'), details: bankDetails, ...common }).strict(),
  z.object({ kind: z.literal('stripe_connect'), details: stripeDetails, ...common }).strict(),
]);
export type CreatePayoutMethodInput = z.infer<typeof createPayoutMethodSchema>;
export const updatePayoutMethodSchema = z.object({ label: z.string().trim().max(80).optional(), is_default: z.literal(true).optional() }).strict();

type Details = z.infer<typeof mobileDetails> | z.infer<typeof bankDetails> | z.infer<typeof stripeDetails>;

const last = (value: string, count = 4) => value.slice(-count);

function describe(input: CreatePayoutMethodInput): { mask: string; identifier: string } {
  if (input.kind === 'mobile_money') {
    return { mask: `${operatorLabels[input.details.operator]} ••••${last(input.details.phone)}`, identifier: input.details.phone };
  }
  if (input.kind === 'bank_account') {
    if (input.details.iban) return { mask: `${input.details.iban.slice(0, 4)} •••• ${last(input.details.iban)}`, identifier: input.details.iban };
    return { mask: `${input.details.bank_code} •••• ${last(input.details.account_number!)}`, identifier: `${input.details.bank_code}:${input.details.account_number}` };
  }
  return { mask: `acct_••••${last(input.details.account_id)}`, identifier: input.details.account_id };
}

const sealContext = (methodId: string) => `payout:${methodId}`;

export function readPayoutDetails(method: Pick<PayoutMethodRow, 'id' | 'details_sealed'>): Details {
  if (!method.details_sealed) throw new HttpError(409, 'Les coordonnées de ce moyen de versement ont été supprimées.');
  return JSON.parse(unseal(method.details_sealed, sealContext(method.id))) as Details;
}

export function payoutRecipient(method: PayoutMethodRow, user: { name: string; email?: string }): PayoutRecipient {
  const details = readPayoutDetails(method) as Record<string, string | undefined>;
  const { email } = user;
  if (method.kind === 'mobile_money') return { name: details.account_name!, phone: details.phone, operator: details.operator, country: method.country, email };
  if (method.kind === 'bank_account') {
    return { name: details.account_holder!, accountNumber: details.iban ?? details.account_number, bankCode: details.bic ?? details.bank_code, country: method.country, email };
  }
  return { name: user.name, accountId: details.account_id, country: method.country, email };
}

function providerMethod(kind: PayoutKind) {
  return kind === 'mobile_money' ? 'mobile_money' : kind === 'bank_account' ? 'bank_transfer' : undefined;
}

/** Providers able to pay this method right now (current payment mode), preferred provider first. */
export function payoutProviders(method: Pick<PayoutMethodRow, 'kind' | 'provider' | 'currency' | 'country'>): PaymentProvider[] {
  if (!activeEnvironment()) return [];
  const candidates = (method.kind === 'stripe_connect'
    ? enabledProviders({ currency: method.currency }).filter((provider) => provider.id === 'stripe')
    : enabledProviders({ currency: method.currency, country: method.country, method: providerMethod(method.kind) }))
    .filter((provider) => provider.capabilities.payout && typeof provider.payout === 'function');
  return method.provider ? candidates.filter((provider) => provider.id === method.provider) : candidates;
}

export function methodView(method: PayoutMethodRow, options: { availability?: boolean } = {}) {
  return {
    id: method.id,
    kind: method.kind,
    provider: method.provider,
    label: method.label,
    display_mask: method.display_mask,
    country: method.country,
    currency: method.currency,
    is_default: !!method.is_default,
    verified_at: method.verified_at,
    deleted_at: method.deleted_at,
    created_at: method.created_at,
    ...(options.availability ? { payout_available: !method.deleted_at && payoutProviders(method).length > 0 } : {}),
  };
}

export function getOwnMethod(userId: string, methodId: string, options: { includeDeleted?: boolean } = {}): PayoutMethodRow {
  const method = one<PayoutMethodRow>('SELECT * FROM payout_methods WHERE id=? AND user_id=?', methodId, userId);
  if (!method || (method.deleted_at && !options.includeDeleted)) throw new HttpError(404, 'Moyen de versement introuvable.');
  return method;
}

export function listPayoutMethods(userId: string) {
  return all<PayoutMethodRow>('SELECT * FROM payout_methods WHERE user_id=? AND deleted_at IS NULL ORDER BY is_default DESC, created_at DESC', userId)
    .map((method) => methodView(method, { availability: true }));
}

/** True when another account registered the same payout destination (multi-account / mule signal). */
export function sharedWithOtherUser(method: Pick<PayoutMethodRow, 'fingerprint' | 'user_id'>): boolean {
  return !!one('SELECT 1 FROM payout_methods WHERE fingerprint=? AND user_id!=? LIMIT 1', method.fingerprint, method.user_id);
}

export function createPayoutMethod(userId: string, input: CreatePayoutMethodInput) {
  if (currencyExponent[input.currency] === undefined) throw new HttpError(400, `Devise non prise en charge : ${input.currency}.`);
  try { payoutFromBase(100, input.currency); } catch { throw new HttpError(400, `Aucun taux de change n’est configuré pour ${input.currency}.`); }
  let provider = input.provider ?? null;
  if (input.kind === 'stripe_connect') provider = 'stripe';
  if (provider) {
    const known = getProvider(provider);
    if (!known || !known.capabilities.payout) throw new HttpError(400, 'Ce prestataire ne permet pas les versements.');
  }
  const { mask, identifier } = describe(input);
  const fingerprint = keyedHash(`${input.kind}:${identifier}`, 'payout-method');
  const methodId = id();
  const sealed = seal(JSON.stringify(input.details), sealContext(methodId));
  const created = transaction(() => {
    const active = one<{ count: number }>('SELECT COUNT(*) AS count FROM payout_methods WHERE user_id=? AND deleted_at IS NULL', userId)!.count;
    if (active >= MAX_METHODS) throw new HttpError(409, `Vous ne pouvez pas enregistrer plus de ${MAX_METHODS} moyens de versement.`);
    if (one('SELECT 1 FROM payout_methods WHERE user_id=? AND fingerprint=? AND deleted_at IS NULL', userId, fingerprint)) {
      throw new HttpError(409, 'Ce moyen de versement est déjà enregistré.');
    }
    const makeDefault = input.make_default || active === 0;
    if (makeDefault) run('UPDATE payout_methods SET is_default=0,updated_at=? WHERE user_id=? AND is_default=1', now(), userId);
    run(`INSERT INTO payout_methods(id,user_id,kind,provider,label,details_sealed,display_mask,fingerprint,country,currency,is_default)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, methodId, userId, input.kind, provider, input.label, sealed, mask, fingerprint, input.country, input.currency, makeDefault ? 1 : 0);
    const user = one<{ email: string }>('SELECT email FROM users WHERE id=?', userId)!;
    notify(userId, 'compliance.payout_method_added', 'Nouveau moyen de versement', `${mask} a été ajouté à votre compte.`, '/wallet');
    const email = renderEmail({
      title: 'Un moyen de versement a été ajouté',
      paragraphs: [`Le moyen de versement ${mask} vient d’être ajouté à votre compte Alpha.`, 'Si vous n’êtes pas à l’origine de cette action, changez immédiatement votre mot de passe et contactez le support.'],
      action: { label: 'Voir mon portefeuille', url: '/wallet' },
    });
    queueEmail({ to: user.email, userId, category: 'security.payout_method', subject: 'Nouveau moyen de versement sur votre compte Alpha', ...email });
    return one<PayoutMethodRow>('SELECT * FROM payout_methods WHERE id=?', methodId)!;
  });
  return methodView(created, { availability: true });
}

export function updatePayoutMethod(userId: string, methodId: string, input: z.infer<typeof updatePayoutMethodSchema>) {
  return transaction(() => {
    const method = getOwnMethod(userId, methodId);
    const timestamp = now();
    if (input.is_default) {
      run('UPDATE payout_methods SET is_default=0,updated_at=? WHERE user_id=? AND is_default=1', timestamp, userId);
      run('UPDATE payout_methods SET is_default=1,updated_at=? WHERE id=?', timestamp, method.id);
    }
    if (input.label !== undefined) run('UPDATE payout_methods SET label=?,updated_at=? WHERE id=?', input.label, timestamp, method.id);
    return methodView(one<PayoutMethodRow>('SELECT * FROM payout_methods WHERE id=?', method.id)!, { availability: true });
  });
}

/** Soft delete: the masked row stays for the withdrawal history, the sealed details are destroyed. */
export function deletePayoutMethod(userId: string, methodId: string) {
  transaction(() => {
    const method = getOwnMethod(userId, methodId);
    if (one("SELECT 1 FROM withdrawals WHERE payout_method_id=? AND status IN ('requested','on_hold','approved','processing')", method.id)) {
      throw new HttpError(409, 'Un retrait en cours utilise ce moyen de versement. Attendez sa clôture ou annulez-le.');
    }
    const timestamp = now();
    run("UPDATE payout_methods SET deleted_at=?,is_default=0,details_sealed='',updated_at=? WHERE id=?", timestamp, timestamp, method.id);
    if (method.is_default) {
      const next = one<{ id: string }>('SELECT id FROM payout_methods WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', userId);
      if (next) run('UPDATE payout_methods SET is_default=1,updated_at=? WHERE id=?', timestamp, next.id);
    }
  });
}

export function exportPayoutMethods(userId: string) {
  return all<PayoutMethodRow>('SELECT * FROM payout_methods WHERE user_id=? ORDER BY created_at', userId).map((method) => methodView(method));
}

export function erasePayoutMethods(userId: string) {
  const timestamp = now();
  run(`UPDATE payout_methods SET details_sealed='',display_mask='••••',label='',fingerprint='erased:'||id,is_default=0,
    deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE user_id=?`, timestamp, timestamp, userId);
}
