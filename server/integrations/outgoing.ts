import { randomUUID } from 'node:crypto';
import { canManageProject, HttpError, id, notify, now } from '../core.js';
import { all, one, run, transaction } from '../db.js';
import { afterCommit, onDomainEvent } from '../platform/events.js';
import { registerJob, runJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { hmacHex, randomToken, seal, unseal } from '../platform/secrets.js';
import { getSetting } from '../platform/settings.js';
import { z } from 'zod';
import { buildEventData, publicEventType, resolveProjectId, type PublicEventType } from './catalog.js';
import { postToVettedTarget, UnsafeUrlError, vetWebhookUrl } from './ssrf.js';

export const MAX_ATTEMPTS = 8;
export const DISABLE_AFTER_FAILURES = 20;
/** Delay before attempt n+1 after the n-th failure: 1 min → 12 h. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000];
const ROTATION_GRACE_MS = 24 * 3600_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const CONCURRENCY = 8;
const BATCH = 50;

export const webhookSettingsSchema = z.object({
  enabled: z.boolean(),
  max_endpoints_per_project: z.number().int().min(1).max(50),
}).strict();
export const webhookDefaults = { enabled: true, max_endpoints_per_project: 10 };
export const webhookSettings = () => getSetting('integrations.webhooks', webhookSettingsSchema, webhookDefaults);

export interface EndpointRow {
  id: string;
  owner_id: string;
  project_id: string;
  url: string;
  description: string;
  secret_sealed: string;
  previous_secret_sealed: string | null;
  previous_secret_expires_at: string | null;
  events: string;
  active: number;
  consecutive_failures: number;
  disabled_reason: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  last_error: string;
  duration_ms: number | null;
  redelivery_of: string | null;
  created_at: string;
  updated_at: string;
}

export const secretContext = (endpointId: string) => `integration_webhook_endpoint:${endpointId}`;
const previousSecretContext = (endpointId: string) => `integration_webhook_endpoint:${endpointId}:previous`;

/** Consumer-facing secret format (`whsec_…`). Shown exactly once, at creation or rotation. */
export const newEndpointSecret = () => `whsec_${randomToken(32)}`;

export function publicEndpoint(row: EndpointRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    owner_id: row.owner_id,
    url: row.url,
    description: row.description,
    events: JSON.parse(row.events) as string[],
    active: !!row.active,
    consecutive_failures: row.consecutive_failures,
    disabled_reason: row.disabled_reason,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    secret: { configured: true, rotating: !!row.previous_secret_expires_at && row.previous_secret_expires_at > now() },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDelivery(row: DeliveryRow) {
  const { payload: _payload, ...rest } = row;
  return rest;
}

/** `t=<unix>,v1=<hex>` (+ a second `v1` signed with the previous secret during the 24 h rotation window). */
export function signatureHeader(secrets: string[], timestamp: number, body: string) {
  return [`t=${timestamp}`, ...secrets.map((secret) => `v1=${hmacHex(secret, `${timestamp}.${body}`)}`)].join(',');
}

function endpointSecrets(endpoint: EndpointRow): string[] {
  const secrets = [unseal(endpoint.secret_sealed, secretContext(endpoint.id))];
  if (endpoint.previous_secret_sealed && endpoint.previous_secret_expires_at && endpoint.previous_secret_expires_at > now()) {
    try { secrets.push(unseal(endpoint.previous_secret_sealed, previousSecretContext(endpoint.id))); } catch { /* ignore */ }
  }
  return secrets;
}

export function rotateEndpointSecret(endpoint: EndpointRow): string {
  const secret = newEndpointSecret();
  const current = unseal(endpoint.secret_sealed, secretContext(endpoint.id));
  run(`UPDATE integration_webhook_endpoints SET secret_sealed=?,previous_secret_sealed=?,previous_secret_expires_at=?,updated_at=? WHERE id=?`,
    seal(secret, secretContext(endpoint.id)), seal(current, previousSecretContext(endpoint.id)),
    new Date(Date.now() + ROTATION_GRACE_MS).toISOString(), now(), endpoint.id);
  return secret;
}

// ---------------------------------------------------------------------------------------------
// Enqueue (synchronous, inside the audited transaction)
// ---------------------------------------------------------------------------------------------

let immediateDelivery = true;
/** Tests disable the post-commit kick to drive `integrations.deliver` deterministically. */
export function setImmediateDeliveryForTests(enabled: boolean) { immediateDelivery = enabled; }

function kickDelivery() {
  if (immediateDelivery) afterCommit(async () => { await runJob('integrations.deliver'); });
}

function disableEndpoint(endpoint: Pick<EndpointRow, 'id' | 'owner_id' | 'project_id' | 'url'>, reason: string, notifyOwner: boolean) {
  run(`UPDATE integration_webhook_endpoints SET active=0,disabled_reason=?,updated_at=? WHERE id=? AND active=1`, reason, now(), endpoint.id);
  if (notifyOwner) {
    notify(endpoint.owner_id, 'integrations.webhook', 'Webhook sortant désactivé',
      `${reason} Point de terminaison : ${new URL(endpoint.url).host}. Corrigez-le puis réactivez-le.`, '/integrations');
  }
}

/** Inserts one pending delivery per subscribed endpoint of the project. Returns the number of rows created. */
export function enqueueProjectEvent(projectId: string, type: PublicEventType, data: (ownerId: string) => Record<string, unknown> | null, eventId = `evt_${randomUUID()}`): number {
  if (!webhookSettings().enabled) return 0;
  const endpoints = all<EndpointRow>(`SELECT * FROM integration_webhook_endpoints WHERE project_id=? AND active=1
    AND EXISTS (SELECT 1 FROM json_each(events) WHERE value=?)`, projectId, type);
  let created = 0;
  const createdAt = now();
  for (const endpoint of endpoints) {
    if (!canManageProject(endpoint.owner_id, projectId)) {
      disableEndpoint(endpoint, 'Le propriétaire du webhook ne gère plus ce projet.', false);
      continue;
    }
    const payloadData = data(endpoint.owner_id);
    if (!payloadData) continue;
    const payload = JSON.stringify({ id: eventId, type, created_at: createdAt, data: payloadData });
    const result = run(`INSERT INTO integration_webhook_deliveries (id,endpoint_id,event_id,event_type,payload,status,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',?,?,?) ON CONFLICT DO NOTHING`, id(), endpoint.id, eventId, type, payload, createdAt, createdAt, createdAt);
    created += Number(result.changes);
  }
  if (created) kickDelivery();
  return created;
}

onDomainEvent('integrations.webhooks', (event) => {
  const type = publicEventType(event.action);
  if (!type) return;
  try {
    // Savepoint: a failure here must never roll back the business action that was audited.
    transaction(() => {
      const projectId = resolveProjectId(event.target_type, event.target_id);
      if (!projectId) return;
      enqueueProjectEvent(projectId, type, (ownerId) => buildEventData(type, event.target_type, event.target_id, ownerId, projectId));
    });
  } catch (error) {
    log.error('integrations.enqueue_failed', { action: event.action, error });
  }
});

// ---------------------------------------------------------------------------------------------
// Delivery worker
// ---------------------------------------------------------------------------------------------

export interface AttemptOutcome { ok: boolean; status: number | null; error: string; durationMs: number }

export async function sendSigned(endpoint: EndpointRow, deliveryId: string, eventType: string, body: string): Promise<AttemptOutcome> {
  const started = Date.now();
  try {
    const target = await vetWebhookUrl(endpoint.url);
    const timestamp = Math.floor(Date.now() / 1000);
    const result = await postToVettedTarget(target, body, {
      'Content-Type': 'application/json',
      'User-Agent': 'Alpha-Webhooks/1.0',
      'X-Alpha-Event': eventType,
      'X-Alpha-Delivery': deliveryId,
      'X-Alpha-Signature': signatureHeader(endpointSecrets(endpoint), timestamp, body),
    }, DELIVERY_TIMEOUT_MS);
    const ok = result.status >= 200 && result.status < 300;
    return { ok, status: result.status, error: ok ? '' : result.status >= 300 && result.status < 400 ? `Redirection refusée (HTTP ${result.status}).` : `HTTP ${result.status}`, durationMs: result.durationMs };
  } catch (error) {
    const message = error instanceof UnsafeUrlError ? `URL refusée : ${error.message}` : error instanceof Error ? error.message : 'Erreur réseau';
    return { ok: false, status: null, error: message.slice(0, 500), durationMs: Date.now() - started };
  }
}

export function nextAttemptDelay(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

/** Records the outcome of one attempt (retry schedule, dead letter, endpoint health, auto-disable). */
function recordOutcome(delivery: DeliveryRow, endpoint: EndpointRow, outcome: AttemptOutcome, retries: boolean) {
  transaction(() => {
    const attempts = delivery.attempts + 1;
    const at = now();
    if (outcome.ok) {
      run(`UPDATE integration_webhook_deliveries SET status='succeeded',attempts=?,next_attempt_at=NULL,response_status=?,last_error='',duration_ms=?,updated_at=? WHERE id=?`,
        attempts, outcome.status, outcome.durationMs, at, delivery.id);
      run('UPDATE integration_webhook_endpoints SET consecutive_failures=0,last_success_at=?,updated_at=? WHERE id=?', at, at, endpoint.id);
      return;
    }
    const dead = !retries || attempts >= MAX_ATTEMPTS;
    run(`UPDATE integration_webhook_deliveries SET status=?,attempts=?,next_attempt_at=?,response_status=?,last_error=?,duration_ms=?,updated_at=? WHERE id=?`,
      dead ? (retries ? 'dead' : 'failed') : 'failed', attempts,
      dead ? null : new Date(Date.now() + nextAttemptDelay(attempts)).toISOString(), outcome.status, outcome.error.slice(0, 500), outcome.durationMs, at, delivery.id);
    run('UPDATE integration_webhook_endpoints SET consecutive_failures=consecutive_failures+1,last_failure_at=?,updated_at=? WHERE id=?', at, at, endpoint.id);
    const fresh = one<EndpointRow>('SELECT * FROM integration_webhook_endpoints WHERE id=?', endpoint.id);
    if (fresh?.active && fresh.consecutive_failures >= DISABLE_AFTER_FAILURES) {
      disableEndpoint(fresh, `Désactivé automatiquement après ${DISABLE_AFTER_FAILURES} échecs consécutifs.`, true);
    }
  });
}

/** Performs one attempt for a delivery already claimed (status=delivering). */
async function attempt(delivery: DeliveryRow, retries = true): Promise<AttemptOutcome> {
  const endpoint = one<EndpointRow>('SELECT * FROM integration_webhook_endpoints WHERE id=?', delivery.endpoint_id);
  if (!endpoint) return { ok: false, status: null, error: 'Point de terminaison supprimé.', durationMs: 0 };
  const outcome = await sendSigned(endpoint, delivery.id, delivery.event_type, delivery.payload);
  recordOutcome(delivery, endpoint, outcome, retries);
  return outcome;
}

function claim(deliveryId: string, statuses: string[]): DeliveryRow | undefined {
  const marks = statuses.map(() => '?').join(',');
  const result = run(`UPDATE integration_webhook_deliveries SET status='delivering',updated_at=? WHERE id=? AND status IN (${marks})`, now(), deliveryId, ...statuses);
  return result.changes ? one<DeliveryRow>('SELECT * FROM integration_webhook_deliveries WHERE id=?', deliveryId) : undefined;
}

export async function deliverDue(): Promise<{ attempted: number; succeeded: number }> {
  const stale = new Date(Date.now() - 2 * 60_000).toISOString();
  run(`UPDATE integration_webhook_deliveries SET status='failed',next_attempt_at=?,last_error='Tentative interrompue.',updated_at=?
    WHERE status='delivering' AND updated_at<?`, now(), now(), stale);
  let attempted = 0;
  let succeeded = 0;
  for (let round = 0; round < 20; round += 1) {
    const due = all<{ id: string }>(`SELECT d.id FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id
      WHERE d.status IN ('pending','failed') AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at<=? AND e.active=1
      ORDER BY d.next_attempt_at,d.created_at LIMIT ?`, now(), BATCH);
    if (!due.length) break;
    const queue = [...due];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const delivery = claim(next.id, ['pending', 'failed']);
        if (!delivery) continue;
        attempted += 1;
        try {
          if ((await attempt(delivery)).ok) succeeded += 1;
        } catch (error) {
          log.error('integrations.delivery_crashed', { delivery: delivery.id, error });
          run(`UPDATE integration_webhook_deliveries SET status='failed',next_attempt_at=?,updated_at=? WHERE id=? AND status='delivering'`,
            new Date(Date.now() + BACKOFF_MS[0]).toISOString(), now(), delivery.id);
        }
      }
    });
    await Promise.all(workers);
    if (due.length < BATCH) break;
  }
  return { attempted, succeeded };
}

/** Synchronous test ping (single attempt, never retried). */
export async function sendPing(endpoint: EndpointRow): Promise<{ delivery: ReturnType<typeof publicDelivery>; outcome: AttemptOutcome }> {
  const deliveryId = id();
  const eventId = `evt_${randomUUID()}`;
  const createdAt = now();
  const payload = JSON.stringify({ id: eventId, type: 'ping', created_at: createdAt, data: { project_id: endpoint.project_id, endpoint_id: endpoint.id } });
  run(`INSERT INTO integration_webhook_deliveries (id,endpoint_id,event_id,event_type,payload,status,attempts,created_at,updated_at)
    VALUES (?,?,?,'ping',?,'delivering',0,?,?)`, deliveryId, endpoint.id, eventId, payload, createdAt, createdAt);
  const delivery = one<DeliveryRow>('SELECT * FROM integration_webhook_deliveries WHERE id=?', deliveryId)!;
  const outcome = await attempt(delivery, false);
  return { delivery: publicDelivery(one<DeliveryRow>('SELECT * FROM integration_webhook_deliveries WHERE id=?', deliveryId)!), outcome };
}

/** New delivery row with the same event id and payload, attempted immediately (then retried normally). */
export async function redeliver(original: DeliveryRow): Promise<ReturnType<typeof publicDelivery>> {
  const endpoint = one<EndpointRow>('SELECT * FROM integration_webhook_endpoints WHERE id=?', original.endpoint_id);
  if (!endpoint) throw new HttpError(404, 'Point de terminaison introuvable.');
  if (!endpoint.active) throw new HttpError(409, 'Réactivez d’abord ce point de terminaison.');
  const deliveryId = id();
  const createdAt = now();
  run(`INSERT INTO integration_webhook_deliveries (id,endpoint_id,event_id,event_type,payload,status,attempts,redelivery_of,created_at,updated_at)
    VALUES (?,?,?,?,?,'delivering',0,?,?,?)`, deliveryId, endpoint.id, original.event_id, original.event_type, original.payload, original.id, createdAt, createdAt);
  const delivery = one<DeliveryRow>('SELECT * FROM integration_webhook_deliveries WHERE id=?', deliveryId)!;
  await attempt(delivery, original.event_type !== 'ping');
  return publicDelivery(one<DeliveryRow>('SELECT * FROM integration_webhook_deliveries WHERE id=?', deliveryId)!);
}

registerJob({
  name: 'integrations.deliver',
  description: 'Envoie les webhooks sortants signés (nouvelles tentatives avec backoff exponentiel).',
  intervalMs: 15_000,
  enabled: () => webhookSettings().enabled,
  run: async () => {
    const result = await deliverDue();
    if (result.attempted) log.info('integrations.deliveries', result);
  },
});

registerJob({
  name: 'integrations.purge',
  description: 'Purge les états OAuth expirés et l’historique ancien des webhooks entrants et sortants.',
  intervalMs: 24 * 3600_000,
  run: () => {
    const day = 24 * 3600_000;
    const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
    transaction(() => {
      run('DELETE FROM integration_oauth_states WHERE expires_at<?', now());
      run(`UPDATE integration_webhook_deliveries SET status='dead',next_attempt_at=NULL,last_error='Expiré : point de terminaison inactif.',updated_at=?
        WHERE status IN ('pending','failed') AND created_at<?`, now(), ago(3));
      run("DELETE FROM integration_webhook_deliveries WHERE status='succeeded' AND created_at<?", ago(30));
      run("DELETE FROM integration_webhook_deliveries WHERE status IN ('failed','dead') AND created_at<?", ago(90));
      run('DELETE FROM integration_inbound_events WHERE received_at<?', ago(90));
    });
  },
});
