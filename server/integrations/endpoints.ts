import { Router } from 'express';
import { z } from 'zod';
import { audit, canManageProject, HttpError, id, now, param, requireUser } from '../core.js';
import { all, one, run, transaction } from '../db.js';
import { hit } from '../platform/rateLimit.js';
import { seal } from '../platform/secrets.js';
import { eventCatalog, publicEventTypes } from './catalog.js';
import {
  newEndpointSecret, publicDelivery, publicEndpoint, redeliver, rotateEndpointSecret, secretContext, sendPing, webhookSettings,
  type DeliveryRow, type EndpointRow,
} from './outgoing.js';
import { managedProject, projectIdSchema } from './sources.js';
import { parseWebhookUrl, UnsafeUrlError, vetWebhookUrl } from './ssrf.js';

const eventsSchema = z.array(z.enum(publicEventTypes)).min(1, 'Choisissez au moins un événement.').max(publicEventTypes.length)
  .transform((events) => [...new Set(events)]);
const urlSchema = z.string().trim().min(8).max(2000);

/** Validates the URL shape AND its DNS resolution now, so members get immediate feedback (re-checked at each delivery). */
async function vetUrl(raw: string): Promise<string> {
  try {
    const url = parseWebhookUrl(raw);
    await vetWebhookUrl(url.toString());
    return url.toString();
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new HttpError(400, error.message);
    throw error;
  }
}

function managedEndpoint(userId: string, value: string): EndpointRow {
  const endpoint = one<EndpointRow>('SELECT * FROM integration_webhook_endpoints WHERE id=?', projectIdSchema.parse(value));
  if (!endpoint || !canManageProject(userId, endpoint.project_id)) throw new HttpError(404, 'Webhook introuvable.');
  return endpoint;
}

const fetchEndpoint = (endpointId: string) => one<EndpointRow>('SELECT * FROM integration_webhook_endpoints WHERE id=?', endpointId)!;

export const endpointsRouter = Router();

endpointsRouter.get('/endpoints/catalog', (_req, res) => {
  res.json({
    events: eventCatalog,
    signature: { header: 'X-Alpha-Signature', format: 't=<horodatage unix>,v1=<HMAC-SHA256 hex de "t.corps">', tolerance_seconds: 300 },
    settings: webhookSettings(),
  });
});

endpointsRouter.get('/projects/:projectId/endpoints', (req, res) => {
  const project = managedProject(requireUser(req).id, param(req, 'projectId'));
  const endpoints = all<EndpointRow>('SELECT * FROM integration_webhook_endpoints WHERE project_id=? ORDER BY created_at', project.id);
  res.json({ project, endpoints: endpoints.map(publicEndpoint), settings: webhookSettings() });
});

endpointsRouter.post('/projects/:projectId/endpoints', async (req, res) => {
  const user = requireUser(req);
  const project = managedProject(user.id, param(req, 'projectId'));
  const input = z.object({ url: urlSchema, description: z.string().trim().max(200).default(''), events: eventsSchema }).strict().parse(req.body);
  const settings = webhookSettings();
  if (!settings.enabled) throw new HttpError(503, 'Les webhooks sortants sont désactivés sur cette instance.');
  if (!hit(`integrations.endpoint-create:${user.id}`, 20, 3600_000).allowed) throw new HttpError(429, 'Trop de webhooks créés. Réessayez plus tard.');
  const url = await vetUrl(input.url);
  const endpointId = id();
  const secret = newEndpointSecret();
  transaction(() => {
    const count = one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_webhook_endpoints WHERE project_id=?', project.id)!.total;
    if (count >= settings.max_endpoints_per_project) throw new HttpError(409, `Un projet peut avoir au plus ${settings.max_endpoints_per_project} webhooks sortants.`);
    run(`INSERT INTO integration_webhook_endpoints (id,owner_id,project_id,url,description,secret_sealed,events) VALUES (?,?,?,?,?,?,?)`,
      endpointId, user.id, project.id, url, input.description, seal(secret, secretContext(endpointId)), JSON.stringify(input.events));
    audit(user.id, 'integration.endpoint.created', 'integration_endpoint', endpointId, project.id);
  });
  res.status(201).json({ endpoint: publicEndpoint(fetchEndpoint(endpointId)), secret });
});

endpointsRouter.patch('/endpoints/:id', async (req, res) => {
  const user = requireUser(req);
  const endpoint = managedEndpoint(user.id, param(req));
  const input = z.object({
    url: urlSchema.optional(),
    description: z.string().trim().max(200).optional(),
    events: eventsSchema.optional(),
    active: z.boolean().optional(),
  }).strict().parse(req.body);
  const url = input.url !== undefined ? await vetUrl(input.url) : endpoint.url;
  transaction(() => {
    const reactivate = input.active === true && !endpoint.active;
    // Re-enabling by another manager transfers ownership when the original owner lost access to the project.
    const owner = reactivate && !canManageProject(endpoint.owner_id, endpoint.project_id) ? user.id : endpoint.owner_id;
    run(`UPDATE integration_webhook_endpoints SET url=?,description=?,events=?,active=?,owner_id=?,
      consecutive_failures=CASE WHEN ? THEN 0 ELSE consecutive_failures END,
      disabled_reason=CASE WHEN ? THEN '' WHEN ? THEN 'Désactivé manuellement.' ELSE disabled_reason END,updated_at=? WHERE id=?`,
    url, input.description ?? endpoint.description, input.events ? JSON.stringify(input.events) : endpoint.events,
    input.active === undefined ? endpoint.active : input.active ? 1 : 0, owner,
    reactivate ? 1 : 0, reactivate ? 1 : 0, input.active === false && !!endpoint.active ? 1 : 0, now(), endpoint.id);
    // Work queued while the endpoint was failing is retried right away instead of waiting for its backoff.
    if (reactivate) {
      run(`UPDATE integration_webhook_deliveries SET next_attempt_at=?,updated_at=? WHERE endpoint_id=? AND status IN ('pending','failed')
        AND next_attempt_at IS NOT NULL`, now(), now(), endpoint.id);
    }
    audit(user.id, 'integration.endpoint.updated', 'integration_endpoint', endpoint.id, endpoint.project_id);
  });
  res.json({ endpoint: publicEndpoint(fetchEndpoint(endpoint.id)) });
});

endpointsRouter.delete('/endpoints/:id', (req, res) => {
  const user = requireUser(req);
  const endpoint = managedEndpoint(user.id, param(req));
  transaction(() => {
    run('DELETE FROM integration_webhook_endpoints WHERE id=?', endpoint.id);
    audit(user.id, 'integration.endpoint.deleted', 'integration_endpoint', endpoint.id, endpoint.project_id);
  });
  res.json({ deleted: true });
});

endpointsRouter.post('/endpoints/:id/rotate-secret', (req, res) => {
  const user = requireUser(req);
  const endpoint = managedEndpoint(user.id, param(req));
  const secret = transaction(() => {
    const value = rotateEndpointSecret(endpoint);
    audit(user.id, 'integration.endpoint.secret_rotated', 'integration_endpoint', endpoint.id, endpoint.project_id);
    return value;
  });
  res.json({ endpoint: publicEndpoint(fetchEndpoint(endpoint.id)), secret, previous_secret_valid_until: fetchEndpoint(endpoint.id).previous_secret_expires_at });
});

endpointsRouter.post('/endpoints/:id/test', async (req, res) => {
  const user = requireUser(req);
  const endpoint = managedEndpoint(user.id, param(req));
  if (!hit(`integrations.endpoint-test:${endpoint.id}`, 10, 60_000).allowed) throw new HttpError(429, 'Trop de tests. Réessayez dans une minute.');
  const { delivery, outcome } = await sendPing(endpoint);
  res.json({ ok: outcome.ok, status: outcome.status, error: outcome.error || null, duration_ms: outcome.durationMs, delivery });
});

endpointsRouter.get('/endpoints/:id/deliveries', (req, res) => {
  const user = requireUser(req);
  const endpoint = managedEndpoint(user.id, param(req));
  const query = z.object({
    status: z.enum(['pending', 'delivering', 'succeeded', 'failed', 'dead']).optional(),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }).strict().parse(req.query);
  const rows = all<DeliveryRow>(`SELECT * FROM integration_webhook_deliveries WHERE endpoint_id=? AND (? IS NULL OR status=?)
    ORDER BY created_at DESC,id LIMIT 51 OFFSET ?`, endpoint.id, query.status ?? null, query.status ?? null, query.offset);
  res.json({ deliveries: rows.slice(0, 50).map(publicDelivery), has_more: rows.length > 50, offset: query.offset });
});

function managedDelivery(userId: string, value: string): DeliveryRow {
  const delivery = one<DeliveryRow>('SELECT * FROM integration_webhook_deliveries WHERE id=?', projectIdSchema.parse(value));
  if (!delivery) throw new HttpError(404, 'Livraison introuvable.');
  managedEndpoint(userId, delivery.endpoint_id);
  return delivery;
}

endpointsRouter.get('/deliveries/:id', (req, res) => {
  const delivery = managedDelivery(requireUser(req).id, param(req));
  res.json({ delivery: { ...publicDelivery(delivery), payload: JSON.parse(delivery.payload) } });
});

endpointsRouter.post('/deliveries/:id/redeliver', async (req, res) => {
  const user = requireUser(req);
  const delivery = managedDelivery(user.id, param(req));
  if (delivery.status === 'delivering' || delivery.status === 'pending') throw new HttpError(409, 'Cette livraison est encore en cours.');
  if (!hit(`integrations.endpoint-test:${delivery.endpoint_id}`, 10, 60_000).allowed) throw new HttpError(429, 'Trop de renvois. Réessayez dans une minute.');
  res.json({ delivery: await redeliver(delivery) });
});
