import { one, run, transaction } from '../db.js';
import { audit, HttpError, id, notify, now, type User } from '../core.js';
import { log } from '../platform/log.js';
import { appOrigin } from '../platform/settings.js';
import { providerContext, readProviderConfig } from './config.js';
import { baseCurrency, fromBase, paymentMode, type LedgerMode } from './mode.js';
import { getProvider } from './providers/index.js';
import type { PaymentMethod, PaymentProvider, ProviderConfig, StatusResult, WebhookEvent } from './providers/types.js';
import { campaignMoneyRow, hasDemoFunds, remainingToFund } from './core/budget.js';
import { alertAdmins, backoffMs, formatMoney, getIntent, isoIn, maskPhone, publicIntent, safeReason, type IntentPurpose, type IntentRow } from './core/store.js';
import { settleSucceededIntent } from './escrow.js';

export const INTENT_TTL_MS = 60 * 60_000;

export interface CreateIntentInput {
  purpose: IntentPurpose;
  ref_id: string;
  provider: string;
  method?: PaymentMethod;
  phone?: string;
  operator?: string;
  currency?: string;
  country?: string;
  amount_base_minor?: number;
  idempotency_key?: string;
}

/** Provider currency: explicit choice, then the provider's configured currency, then the base currency, then its first currency. */
function chooseCurrency(provider: PaymentProvider, config: ProviderConfig, requested?: string): string {
  if (requested) {
    if (!provider.currencies.includes(requested)) throw new HttpError(400, `${provider.label} ne prend pas en charge la devise ${requested}.`);
    return requested;
  }
  const configured = config.settings.currency;
  if (configured && provider.currencies.includes(configured)) return configured;
  const base = baseCurrency();
  return provider.currencies.includes(base) ? base : provider.currencies[0];
}

/** Authorization + amount (base currency) for the requested purpose. Runs inside the creation transaction. */
function quote(user: User, input: CreateIntentInput, mode: LedgerMode) {
  if (input.purpose === 'campaign_funding') {
    const campaign = campaignMoneyRow(input.ref_id);
    if (!campaign) throw new HttpError(404, 'Campagne introuvable.');
    if (campaign.owner_id !== user.id) throw new HttpError(403, 'Seul le responsable peut financer cette campagne.');
    if (campaign.status !== 'open') throw new HttpError(409, 'Cette campagne est fermée.');
    if (campaign.payment_mode === 'demo' && hasDemoFunds(campaign.id)) {
      throw new HttpError(409, 'Cette campagne a reçu des fonds de démonstration : elle ne peut pas recevoir de fonds réels. Créez une nouvelle campagne.');
    }
    if (campaign.payment_mode !== 'demo' && campaign.payment_mode !== mode) {
      throw new HttpError(409, `Cette campagne est financée en mode ${campaign.payment_mode === 'live' ? 'réel' : 'bac à sable'} : impossible d’y mélanger d’autres fonds.`);
    }
    const remaining = remainingToFund(campaign, mode);
    if (remaining <= 0) throw new HttpError(409, 'Le budget de cette campagne est déjà entièrement financé.');
    const amount = input.amount_base_minor ?? remaining;
    if (amount > remaining) throw new HttpError(400, 'Montant supérieur au budget restant à financer.');
    return { amount, refType: 'campaign' as const, description: `Financement de la campagne « ${campaign.title} »` };
  }
  const listing = one<{ id: string; seller_id: string; title: string; status: string; price_cents: number }>(
    'SELECT id,seller_id,title,status,price_cents FROM listings WHERE id=?', input.ref_id);
  if (!listing) throw new HttpError(404, 'Offre introuvable.');
  if (listing.status !== 'active') throw new HttpError(409, 'Cette offre est archivée.');
  if (listing.seller_id === user.id) throw new HttpError(403, 'Vous ne pouvez pas acheter votre propre offre.');
  if (one("SELECT id FROM orders WHERE listing_id=? AND buyer_id=? AND status IN ('paid','delivered','disputed')", listing.id, user.id)) {
    throw new HttpError(409, 'Vous avez déjà une commande active pour cette offre. Consultez vos commandes.');
  }
  if (input.amount_base_minor !== undefined && input.amount_base_minor !== listing.price_cents) {
    throw new HttpError(400, 'Le montant d’un achat est le prix de l’offre.');
  }
  return { amount: listing.price_cents, refType: 'listing' as const, description: `Achat « ${listing.title} » sur Alpha` };
}

/** Accepts provider redirects that are either same-origin paths or absolute HTTPS (HTTP only in sandbox). */
function safeRedirect(url: string, mode: LedgerMode): string {
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (URL.canParse(url)) {
    const protocol = new URL(url).protocol;
    if (protocol === 'https:' || (mode === 'sandbox' && protocol === 'http:')) return url;
  }
  throw new Error('URL de redirection du prestataire refusée.');
}

/**
 * Creates a payment intent (transaction), asks the provider to start the collection (outside any transaction)
 * and stores the result. Returns the redirect URL or the instructions to show to the payer.
 */
export async function createIntent(user: User, input: CreateIntentInput) {
  const mode = paymentMode();
  if (mode === 'demo') throw new HttpError(409, 'Les paiements réels sont désactivés : la plateforme est en mode démonstration.');
  const provider = getProvider(input.provider);
  if (!provider) throw new HttpError(404, 'Prestataire de paiement inconnu.');
  const config = readProviderConfig(provider.id, mode);
  if (!config || !provider.capabilities.collect || provider.validateConfig(config).length) {
    throw new HttpError(409, 'Ce moyen de paiement n’est pas disponible actuellement.');
  }
  const method: PaymentMethod | undefined = input.method
    ?? (input.phone && provider.methods.includes('mobile_money') ? 'mobile_money' : provider.methods[0]);
  if (method && !provider.methods.includes(method)) throw new HttpError(400, `${provider.label} ne propose pas ce moyen de paiement.`);
  if (method === 'mobile_money' && !input.phone) throw new HttpError(400, 'Indiquez le numéro de téléphone du compte mobile money.');
  const currency = chooseCurrency(provider, config, input.currency);
  const idempotencyKey = `${user.id}:${input.idempotency_key ?? id()}`;

  const existing = one<IntentRow>('SELECT * FROM payment_intents WHERE idempotency_key=?', idempotencyKey);
  if (existing) {
    if (existing.purpose !== input.purpose || existing.ref_id !== input.ref_id || existing.provider !== provider.id) {
      throw new HttpError(409, 'Cette clé d’idempotence a déjà servi pour un autre paiement.');
    }
    return { intent: publicIntent(existing), redirect_url: existing.redirect_url, instructions: existing.instructions, reused: true };
  }

  const intentId = id();
  transaction(() => {
    const { amount, refType } = quote(user, input, mode);
    let amountMinor: number;
    try { amountMinor = fromBase(amount, currency); } catch {
      throw new HttpError(400, `Aucun taux de change configuré pour ${currency}.`);
    }
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new HttpError(400, 'Montant invalide pour cette devise.');
    // A new attempt supersedes the payer's previous open attempts for the same resource (a late success is still honoured).
    run(`UPDATE payment_intents SET status='cancelled',failure_reason='Remplacé par une nouvelle tentative de paiement.',updated_at=?
      WHERE user_id=? AND purpose=? AND ref_id=? AND status IN ('created','pending')`, now(), user.id, input.purpose, input.ref_id);
    run(`INSERT INTO payment_intents (id,user_id,purpose,ref_type,ref_id,mode,provider,method,operator,amount_base_minor,base_currency,
      amount_minor,currency,fx_rate,idempotency_key,customer_phone_masked,expires_at,next_check_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    intentId, user.id, input.purpose, refType, input.ref_id, mode, provider.id, method ?? null, input.operator ?? null, amount, baseCurrency(),
    amountMinor, currency, amountMinor / amount, idempotencyKey, maskPhone(input.phone), isoIn(INTENT_TTL_MS), isoIn(backoffMs(0)));
    audit(user.id, 'payments.intent.created', 'payment_intent', intentId, JSON.stringify({ purpose: input.purpose, ref_id: input.ref_id, provider: provider.id, amount_minor: amount, mode }));
  });

  const intent = getIntent(intentId)!;
  const email = one<{ email: string }>('SELECT email FROM users WHERE id=?', user.id)?.email ?? user.email;
  let result;
  try {
    result = await provider.collect(config, {
      reference: intent.id,
      amountMinor: intent.amount_minor,
      currency: intent.currency,
      description: quoteDescription(intent),
      customer: { name: user.name, email, ...(input.phone ? { phone: input.phone } : {}), ...(input.country ? { country: input.country } : {}) },
      returnUrl: `${appOrigin()}/checkout/return?intent=${intent.id}`,
      cancelUrl: `${appOrigin()}/checkout/cancel?intent=${intent.id}`,
      method,
      operator: input.operator,
    }, providerContext(provider.id));
  } catch (error) {
    const reason = safeReason(error, 'Le prestataire n’a pas pu initier le paiement.');
    log.warn('payments.collect.failed', { intent: intent.id, provider: provider.id, error: reason });
    transaction(() => {
      run("UPDATE payment_intents SET status='failed',failure_reason=?,next_check_at=NULL,updated_at=? WHERE id=? AND status='created'", reason, now(), intent.id);
      audit(user.id, 'payments.intent.failed', 'payment_intent', intent.id, reason);
    });
    throw new HttpError(502, 'Le prestataire de paiement n’a pas pu initier le paiement. Réessayez ou choisissez un autre moyen de paiement.');
  }

  try {
    transaction(() => {
      const redirect = result.kind === 'redirect' ? safeRedirect(result.url, mode) : null;
      const instructions = result.kind === 'pending_approval' ? result.instructions.slice(0, 1000) : '';
      run(`UPDATE payment_intents SET provider_reference=COALESCE(provider_reference,?),redirect_url=?,instructions=?,
        status=CASE WHEN status='created' THEN 'pending' ELSE status END,updated_at=? WHERE id=?`,
      result.providerReference, redirect, instructions, now(), intent.id);
    });
  } catch (error) {
    const reason = safeReason(error, 'Réponse du prestataire invalide.');
    transaction(() => {
      run("UPDATE payment_intents SET status='failed',failure_reason=?,next_check_at=NULL,updated_at=? WHERE id=? AND status IN ('created','pending')", reason, now(), intent.id);
      alertAdmins('Réponse prestataire invalide', `Intention ${intent.id} (${provider.id}) : ${reason}`);
    });
    throw new HttpError(502, 'Réponse du prestataire de paiement invalide. Aucun montant n’a été crédité.');
  }
  const stored = getIntent(intent.id)!;
  return { intent: publicIntent(stored), redirect_url: stored.redirect_url, instructions: stored.instructions, reused: false };
}

function quoteDescription(intent: IntentRow) {
  if (intent.purpose === 'campaign_funding') {
    const title = one<{ title: string }>('SELECT title FROM campaigns WHERE id=?', intent.ref_id)?.title ?? '';
    return `Financement de la campagne « ${title} »`.slice(0, 200);
  }
  const title = one<{ title: string }>('SELECT title FROM listings WHERE id=?', intent.ref_id)?.title ?? '';
  return `Achat « ${title} » sur Alpha`.slice(0, 200);
}

function sameAmount(intent: IntentRow, amountMinor?: number, currency?: string) {
  if (amountMinor !== undefined && amountMinor !== intent.amount_minor) return false;
  if (currency !== undefined && currency.toUpperCase() !== intent.currency) return false;
  return true;
}

/**
 * Applies a provider-confirmed status to an intent. `succeeded` credits the escrow exactly once, after checking
 * amount and currency against the intent (a mismatch blocks the intent for admin review and never credits).
 */
export function applyProviderStatus(intentId: string, result: StatusResult, source: string, event?: Pick<WebhookEvent, 'amountMinor' | 'currency'>) {
  return transaction(() => {
    const intent = getIntent(intentId);
    if (!intent) throw new HttpError(404, 'Paiement introuvable.');
    run('UPDATE payment_intents SET last_checked_at=?,provider_reference=COALESCE(provider_reference,?) WHERE id=?', now(), result.providerReference || null, intent.id);
    if (result.status === 'pending') {
      if (intent.status === 'created') run("UPDATE payment_intents SET status='pending',updated_at=? WHERE id=?", now(), intent.id);
      return getIntent(intent.id)!;
    }
    if (result.status === 'failed' || result.status === 'cancelled') {
      if (intent.status === 'created' || intent.status === 'pending') {
        const reason = safeReason(result.failureReason, result.status === 'cancelled' ? 'Paiement annulé.' : 'Paiement refusé par le prestataire.');
        run('UPDATE payment_intents SET status=?,failure_reason=?,next_check_at=NULL,updated_at=? WHERE id=?', result.status, reason, now(), intent.id);
        notify(intent.user_id, 'payment', result.status === 'cancelled' ? 'Paiement annulé' : 'Paiement échoué', reason, `/checkout/return?intent=${intent.id}`);
        audit(intent.user_id, `payments.intent.${result.status}`, 'payment_intent', intent.id, source);
      }
      return getIntent(intent.id)!;
    }
    if (intent.settlement !== 'none' || intent.review_required) return intent;
    if (!sameAmount(intent, result.amountMinor, result.currency) || !sameAmount(intent, event?.amountMinor, event?.currency)) {
      const detail = `attendu ${formatMoney(intent.amount_minor, intent.currency)}, reçu ${result.amountMinor ?? event?.amountMinor ?? '?'} ${result.currency ?? event?.currency ?? ''}`.trim();
      run(`UPDATE payment_intents SET status='failed',review_required=1,failure_reason=?,next_check_at=NULL,updated_at=? WHERE id=?`,
        'Montant ou devise incohérents : paiement bloqué pour vérification.', now(), intent.id);
      alertAdmins('Paiement bloqué : montant incohérent', `Intention ${intent.id} (${intent.provider}) : ${detail}. Aucun crédit n’a été effectué.`);
      notify(intent.user_id, 'payment', 'Paiement en vérification', 'Le montant reçu ne correspond pas à la commande : notre équipe vérifie le paiement.', `/checkout/return?intent=${intent.id}`);
      audit(intent.user_id, 'payments.intent.amount_mismatch', 'payment_intent', intent.id, `${source}: ${detail}`);
      return getIntent(intent.id)!;
    }
    settleSucceededIntent(intent.id, source);
    return getIntent(intent.id)!;
  });
}

/** Asks the provider for the authoritative status of a collection (never trusts a webhook alone). */
export async function fetchCollectionStatus(intent: IntentRow, providerReference = intent.provider_reference): Promise<StatusResult> {
  const provider = getProvider(intent.provider);
  const config = readProviderConfig(intent.provider, intent.mode);
  if (!provider || !config) throw new HttpError(409, 'Le prestataire de ce paiement est désactivé pour cet environnement.');
  if (!providerReference) throw new HttpError(409, 'Ce paiement n’a pas encore de référence prestataire.');
  const result = await provider.status(config, 'collection', providerReference, providerContext(provider.id), intent.id);
  if (result.providerReference && intent.provider_reference && result.providerReference !== intent.provider_reference) {
    throw new Error('Référence prestataire incohérente.');
  }
  return { ...result, providerReference: result.providerReference || providerReference };
}

/** Re-confirms an intent with the provider and applies the result (payer refresh, admin reconcile, reconcile job). */
export async function refreshIntent(intentId: string, source: string) {
  const intent = getIntent(intentId);
  if (!intent) throw new HttpError(404, 'Paiement introuvable.');
  // Cancelled/expired intents are still checked: a late provider success must be honoured (or refunded).
  if (intent.settlement !== 'none' || intent.review_required || !intent.provider_reference) return intent;
  try {
    const result = await fetchCollectionStatus(intent);
    return applyProviderStatus(intent.id, result, source);
  } catch (error) {
    transaction(() => run('UPDATE payment_intents SET attempts=attempts+1,next_check_at=?,last_checked_at=?,updated_at=? WHERE id=?',
      isoIn(backoffMs(intent.attempts + 1)), now(), now(), intent.id));
    if (error instanceof HttpError) throw error;
    log.warn('payments.status.failed', { intent: intent.id, provider: intent.provider, error: safeReason(error) });
    throw new HttpError(502, 'Le prestataire de paiement ne répond pas. Réessayez dans quelques instants.');
  }
}

/** Payer gives up (cancel page): the intent stops being polled; a late provider success is still honoured. */
export function cancelIntent(intentId: string, userId: string) {
  return transaction(() => {
    const intent = getIntent(intentId);
    if (!intent || intent.user_id !== userId) throw new HttpError(404, 'Paiement introuvable.');
    if (intent.status === 'created' || intent.status === 'pending') {
      run("UPDATE payment_intents SET status='cancelled',failure_reason='Paiement abandonné par le payeur.',updated_at=? WHERE id=?", now(), intent.id);
      audit(userId, 'payments.intent.cancelled', 'payment_intent', intent.id);
    }
    return getIntent(intent.id)!;
  });
}

export function readableIntent(intentId: string, user: User): IntentRow {
  const intent = getIntent(intentId);
  if (!intent || (intent.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Paiement introuvable.');
  return intent;
}
