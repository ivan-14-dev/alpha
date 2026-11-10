import { one, run, transaction } from '../db.js';
import { id, now } from '../core.js';
import { log } from '../platform/log.js';
import { sha256Hex } from '../platform/secrets.js';
import { activeEnvironment, providerContext, readProviderConfig } from './config.js';
import type { LedgerMode } from './mode.js';
import { getProvider } from './providers/index.js';
import type { ProviderId, WebhookEvent, WebhookInput } from './providers/types.js';
import { applyRefundStatus } from './core/refunds.js';
import { safeReason, type IntentRow, type RefundRow } from './core/store.js';
import { applyProviderStatus, fetchCollectionStatus } from './intents.js';

/** Webhooks are acknowledged quickly: processing continues in the background past this delay (errors stay on the event row). */
export const WEBHOOK_INLINE_MS = 5000;

type PayoutHandler = (provider: ProviderId, mode: LedgerMode, event: WebhookEvent) => Promise<void>;
let payoutHandler: PayoutHandler | null = null;
/** Payout events belong to withdrawals (compliance module), which registers its handler here. */
export function registerPayoutWebhookHandler(handler: PayoutHandler | null) { payoutHandler = handler; }

export interface WebhookResponse { status: number; body: Record<string, unknown> }

function eventKey(event: WebhookEvent, bodyHash: string, index: number) {
  return event.eventId ? `id:${String(event.eventId).slice(0, 250)}` : `sha256:${bodyHash}:${index}`;
}

function markEvent(rowId: string, status: 'processed' | 'ignored' | 'failed', error = '', intentId?: string) {
  run('UPDATE payment_webhook_events SET status=?,error=?,intent_id=COALESCE(?,intent_id),processed_at=? WHERE id=?',
    status, error.slice(0, 500), intentId ?? null, now(), rowId);
}

function findIntent(provider: string, event: WebhookEvent): IntentRow | undefined {
  if (event.reference) {
    const byReference = one<IntentRow>('SELECT * FROM payment_intents WHERE id=? AND provider=?', event.reference, provider);
    if (byReference) return byReference;
  }
  if (event.providerReference) {
    return one<IntentRow>('SELECT * FROM payment_intents WHERE provider=? AND provider_reference=?', provider, event.providerReference);
  }
  return undefined;
}

async function processCollection(rowId: string, provider: ProviderId, mode: LedgerMode, event: WebhookEvent) {
  const intent = findIntent(provider, event);
  if (!intent) return markEvent(rowId, 'ignored', 'Aucun paiement correspondant.');
  if (intent.mode !== mode) return markEvent(rowId, 'ignored', 'Paiement d’un autre environnement.', intent.id);
  if (intent.provider_reference && event.providerReference && intent.provider_reference !== event.providerReference) {
    return markEvent(rowId, 'failed', 'Référence prestataire différente de celle du paiement.', intent.id);
  }
  // Webhooks are only hints: the authoritative status always comes from the provider API.
  const result = await fetchCollectionStatus(intent, intent.provider_reference ?? event.providerReference ?? null);
  applyProviderStatus(intent.id, result, `webhook:${provider}`, { amountMinor: event.amountMinor, currency: event.currency });
  markEvent(rowId, 'processed', '', intent.id);
}

async function processRefundEvent(rowId: string, provider: ProviderId, mode: LedgerMode, event: WebhookEvent) {
  const refund = event.providerReference
    ? one<RefundRow>('SELECT * FROM refunds WHERE provider=? AND provider_reference=?', provider, event.providerReference)
    : event.reference ? one<RefundRow>('SELECT * FROM refunds WHERE id=? AND provider=?', event.reference, provider) : undefined;
  if (!refund || refund.mode !== mode || !refund.provider_reference) return markEvent(rowId, 'ignored', 'Aucun remboursement correspondant.');
  const adapter = getProvider(provider)!;
  const config = readProviderConfig(provider, mode)!;
  applyRefundStatus(refund.id, await adapter.status(config, 'refund', refund.provider_reference, providerContext(provider), refund.id));
  markEvent(rowId, 'processed', '', refund.intent_id);
}

async function processEvent(rowId: string, provider: ProviderId, mode: LedgerMode, event: WebhookEvent) {
  try {
    if (event.type === 'collection') await processCollection(rowId, provider, mode, event);
    else if (event.type === 'refund') await processRefundEvent(rowId, provider, mode, event);
    else if (event.type === 'payout' && payoutHandler) {
      await payoutHandler(provider, mode, event);
      markEvent(rowId, 'processed');
    } else markEvent(rowId, 'ignored', 'Type d’événement non traité par les paiements.');
  } catch (error) {
    const reason = safeReason(error, 'Erreur de traitement.');
    log.warn('payments.webhook.failed', { provider, event: rowId, error: reason });
    markEvent(rowId, 'failed', reason);
  }
}

/**
 * Shared webhook pipeline (HTTP route and simulator checkout): authenticate with the ACTIVE environment config,
 * de-duplicate events, re-confirm each one with the provider, settle idempotently.
 */
export async function receiveWebhook(providerId: string, input: WebhookInput): Promise<WebhookResponse> {
  const provider = getProvider(providerId);
  if (!provider) return { status: 404, body: { error: 'Prestataire de paiement inconnu.' } };
  const mode = activeEnvironment();
  const config = mode ? readProviderConfig(provider.id, mode) : null;
  if (!mode || !config) return { status: 404, body: { error: 'Ce prestataire n’est pas actif dans le mode de paiement courant.' } };
  let events: WebhookEvent[] | null;
  try {
    events = await provider.verifyWebhook(config, input, providerContext(provider.id));
  } catch (error) {
    log.warn('payments.webhook.verify_failed', { provider: provider.id, error: safeReason(error) });
    events = null;
  }
  if (events === null) return { status: 401, body: { error: 'Signature de webhook invalide.' } };
  const bodyHash = sha256Hex(Buffer.concat([Buffer.from(`${input.method}\n${JSON.stringify(input.query)}\n`), input.rawBody]));
  const queued = transaction(() => events.flatMap((event, index) => {
    const key = eventKey(event, bodyHash, index);
    const existing = one<{ id: string; status: string }>('SELECT id,status FROM payment_webhook_events WHERE provider=? AND event_key=?', provider.id, key);
    if (existing && existing.status !== 'failed') return [];
    const rowId = existing?.id ?? id();
    if (existing) run("UPDATE payment_webhook_events SET status='received',error='',attempts=attempts+1 WHERE id=?", rowId);
    else {
      run(`INSERT INTO payment_webhook_events (id,provider,event_key,mode,event_type,event_status,reference,provider_reference,attempts)
        VALUES (?,?,?,?,?,?,?,?,1)`, rowId, provider.id, key, mode, String(event.type).slice(0, 40), String(event.status).slice(0, 40),
      event.reference?.slice(0, 200) ?? null, event.providerReference?.slice(0, 200) ?? null);
    }
    return [{ rowId, event }];
  }));
  // Sequential on purpose: two events for the same payment must not race each other.
  const processing = (async () => { for (const { rowId, event } of queued) await processEvent(rowId, provider.id, mode, event); })();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([processing, new Promise((resolve) => { timer = setTimeout(resolve, WEBHOOK_INLINE_MS); })]);
  clearTimeout(timer);
  return { status: 200, body: { received: true, events: events.length, duplicates: events.length - queued.length } };
}
