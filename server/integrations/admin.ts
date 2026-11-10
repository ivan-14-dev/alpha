import { Router } from 'express';
import { z } from 'zod';
import { audit, HttpError, param, requireAdmin } from '../core.js';
import { all, one, transaction } from '../db.js';
import { setSecretSetting, setSetting } from '../platform/settings.js';
import { publicDelivery, redeliver, webhookDefaults, webhookSettings, webhookSettingsSchema, type DeliveryRow } from './outgoing.js';
import { describeProvider, normalizeBaseUrl, providerDefaults, providerIds, providerSchema, secretKey, settingKey } from './providers.js';

const scope = z.string().trim().min(1).max(60).regex(/^[a-z0-9_:.-]+$/i, 'Scope invalide.');
const providerInput = z.object({
  enabled: z.boolean(),
  client_id: z.string().trim().max(200),
  base_url: z.string().trim().url().max(300).optional(),
  scopes: z.array(scope).max(20).optional(),
  private_scopes: z.array(scope).max(20).optional(),
  /** undefined = unchanged, null = remove, string = replace. */
  client_secret: z.string().trim().min(8).max(500).nullable().optional(),
}).strict();

/** Never expose query strings (they may embed consumer tokens) in admin listings. */
const maskUrl = (value: string) => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`; } catch { return ''; }
};

export const adminRouter = Router();
adminRouter.use((req, _res, next) => { requireAdmin(req); next(); });

adminRouter.get('/providers', (_req, res) => {
  res.json({ providers: providerIds.map(describeProvider), webhooks: webhookSettings(), webhook_defaults: webhookDefaults });
});

adminRouter.put('/providers/:provider', (req, res) => {
  const admin = requireAdmin(req);
  const provider = providerSchema.parse(param(req, 'provider'));
  const input = providerInput.parse(req.body);
  const defaults = providerDefaults[provider];
  if (input.base_url && provider !== 'gitlab') throw new HttpError(400, 'Seule une instance GitLab peut avoir une URL personnalisée.');
  const baseUrl = provider === 'gitlab' ? normalizeBaseUrl(input.base_url ?? defaults.base_url) : undefined;
  const current = describeProvider(provider);
  const secretConfigured = input.client_secret === undefined ? current.client_secret.configured : input.client_secret !== null;
  if (input.enabled && (!input.client_id || !secretConfigured)) {
    throw new HttpError(400, 'Renseignez l’identifiant client et le secret avant d’activer ce fournisseur.');
  }
  transaction(() => {
    setSetting(settingKey(provider), {
      enabled: input.enabled,
      client_id: input.client_id,
      ...(baseUrl ? { base_url: baseUrl } : {}),
      scopes: input.scopes?.length ? [...new Set(input.scopes)] : defaults.scopes,
      private_scopes: input.private_scopes ? [...new Set(input.private_scopes)] : current.private_scopes,
    }, admin.id);
    if (input.client_secret !== undefined) setSecretSetting(secretKey(provider), input.client_secret, admin.id);
    audit(admin.id, 'admin.integrations.provider_updated', 'setting', settingKey(provider),
      JSON.stringify({ enabled: input.enabled, secret: input.client_secret === undefined ? 'unchanged' : input.client_secret === null ? 'removed' : 'replaced' }));
  });
  res.json({ provider: describeProvider(provider) });
});

adminRouter.put('/webhooks', (req, res) => {
  const admin = requireAdmin(req);
  const input = webhookSettingsSchema.parse(req.body);
  transaction(() => {
    setSetting('integrations.webhooks', input, admin.id);
    audit(admin.id, 'admin.integrations.webhooks_updated', 'setting', 'integrations.webhooks', JSON.stringify(input));
  });
  res.json({ webhooks: webhookSettings() });
});

adminRouter.get('/overview', (_req, res) => {
  const since = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  res.json({
    connections: all('SELECT provider,COUNT(*) AS total FROM integration_connections WHERE revoked_at IS NULL GROUP BY provider'),
    sources: all('SELECT provider,setup,COUNT(*) AS total FROM integration_project_sources GROUP BY provider,setup'),
    endpoints: one(`SELECT COUNT(*) AS total,COALESCE(SUM(active),0) AS active,COALESCE(SUM(active=0),0) AS disabled
      FROM integration_webhook_endpoints`),
    deliveries_24h: all('SELECT status,COUNT(*) AS total FROM integration_webhook_deliveries WHERE created_at>=? GROUP BY status', since(24)),
    deliveries_7d: all('SELECT status,COUNT(*) AS total FROM integration_webhook_deliveries WHERE created_at>=? GROUP BY status', since(24 * 7)),
    inbound_7d: all('SELECT provider,status,COUNT(*) AS total FROM integration_inbound_events WHERE received_at>=? GROUP BY provider,status', since(24 * 7)),
    disabled_endpoints: all<{ url: string }>(`SELECT e.id,e.project_id,p.title AS project_title,e.url,e.disabled_reason,e.consecutive_failures,e.updated_at
      FROM integration_webhook_endpoints e JOIN projects p ON p.id=e.project_id WHERE e.active=0 ORDER BY e.updated_at DESC LIMIT 20`)
      .map((row) => ({ ...row, url: maskUrl(row.url) })),
  });
});

adminRouter.get('/deliveries', (req, res) => {
  const query = z.object({
    status: z.enum(['pending', 'delivering', 'succeeded', 'failed', 'dead']).default('dead'),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }).strict().parse(req.query);
  const rows = all<DeliveryRow & { url: string; project_id: string; project_title: string }>(`SELECT d.*,e.url,e.project_id,p.title AS project_title
    FROM integration_webhook_deliveries d JOIN integration_webhook_endpoints e ON e.id=d.endpoint_id JOIN projects p ON p.id=e.project_id
    WHERE d.status=? ORDER BY d.updated_at DESC,d.id LIMIT 51 OFFSET ?`, query.status, query.offset);
  res.json({
    deliveries: rows.slice(0, 50).map(({ url, project_id: projectId, project_title: projectTitle, ...row }) => ({
      ...publicDelivery(row), url: maskUrl(url), project_id: projectId, project_title: projectTitle,
    })),
    has_more: rows.length > 50,
    offset: query.offset,
  });
});

adminRouter.post('/deliveries/:id/redeliver', async (req, res) => {
  const admin = requireAdmin(req);
  const delivery = one<DeliveryRow>('SELECT * FROM integration_webhook_deliveries WHERE id=?', param(req));
  if (!delivery) throw new HttpError(404, 'Livraison introuvable.');
  if (delivery.status === 'pending' || delivery.status === 'delivering') throw new HttpError(409, 'Cette livraison est encore en cours.');
  const result = await redeliver(delivery);
  transaction(() => audit(admin.id, 'admin.integrations.delivery_redelivered', 'integration_delivery', delivery.id, delivery.event_type));
  res.json({ delivery: result });
});

adminRouter.get('/inbound', (req, res) => {
  const query = z.object({
    status: z.enum(['received', 'processed', 'ignored', 'failed']).optional(),
    provider: providerSchema.optional(),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }).strict().parse(req.query);
  const rows = all(`SELECT e.id,e.provider,e.delivery_id,e.event_type,e.status,e.summary,e.received_at,e.processed_at,e.project_id,
      p.title AS project_title,s.full_name
    FROM integration_inbound_events e LEFT JOIN projects p ON p.id=e.project_id LEFT JOIN integration_project_sources s ON s.id=e.project_source_id
    WHERE (? IS NULL OR e.status=?) AND (? IS NULL OR e.provider=?) ORDER BY e.received_at DESC,e.id LIMIT 51 OFFSET ?`,
  query.status ?? null, query.status ?? null, query.provider ?? null, query.provider ?? null, query.offset);
  res.json({ events: rows.slice(0, 50), has_more: rows.length > 50, offset: query.offset });
});
