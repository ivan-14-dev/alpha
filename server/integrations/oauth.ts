import { Router } from 'express';
import { z } from 'zod';
import { HttpError, param, requireUser } from '../core.js';
import { hit } from '../platform/rateLimit.js';
import { completeAuthorization, disconnect, listConnections, publicConnection, startAuthorization } from './connections.js';
import { providerConfig, providerIds, providerLabels, providerReady, providerSchema } from './providers.js';

/** Mounted BEFORE the session-required middleware: the callback must answer with a redirect even when signed out. */
export const oauthRouter = Router();

oauthRouter.get('/:provider/start', (req, res) => {
  const user = requireUser(req);
  res.set('Cache-Control', 'private, no-store');
  const provider = providerSchema.parse(param(req, 'provider'));
  const query = z.object({
    access: z.enum(['public', 'private']).default('public'),
    return_to: z.string().max(300).optional(),
  }).strict().parse(req.query);
  // Cross-site pages must not be able to start a flow on behalf of the member (top-level navigation only from Alpha).
  const fetchSite = req.headers['sec-fetch-site'];
  const fromApp = req.headers['x-alpha-client'] === 'web';
  if (!fromApp && typeof fetchSite === 'string' && !['same-origin', 'none'].includes(fetchSite)) {
    throw new HttpError(403, 'Requête non autorisée.');
  }
  if (!hit(`integrations.oauth-start:${user.id}`, 20, 10 * 60_000).allowed) throw new HttpError(429, 'Trop de tentatives de connexion. Réessayez dans quelques minutes.');
  const authorizeUrl = startAuthorization(user, provider, { privateAccess: query.access === 'private', returnTo: query.return_to });
  if (fromApp) res.json({ authorize_url: authorizeUrl });
  else res.redirect(302, authorizeUrl);
});

oauthRouter.get('/:provider/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  const provider = providerSchema.safeParse(req.params.provider);
  if (!provider.success) { res.redirect(302, '/integrations?integration_error=state'); return; }
  const target = await completeAuthorization(req.user, provider.data, req.query as Record<string, unknown>);
  res.redirect(302, target);
});

/** Session-required routes for connected accounts. */
export const connectionsRouter = Router();

connectionsRouter.get('/providers', (req, res) => {
  const user = requireUser(req);
  const connections = listConnections(user.id);
  res.json({
    providers: providerIds.map((provider) => {
      const config = providerConfig(provider);
      const connection = connections.find((row) => row.provider === provider && row.base_url === config.base_url);
      return {
        provider,
        label: providerLabels[provider],
        enabled: providerReady(provider),
        base_url: config.base_url,
        supports_private: config.private_scopes.length > 0,
        connection: connection ? publicConnection(connection) : null,
      };
    }),
  });
});

connectionsRouter.get('/connections', (req, res) => {
  res.json({ connections: listConnections(requireUser(req).id).map(publicConnection) });
});

connectionsRouter.delete('/connections/:id', async (req, res) => {
  const user = requireUser(req);
  const connectionId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(param(req));
  const result = await disconnect(user.id, connectionId);
  res.json({ disconnected: true, ...result, manual_revocation_required: !result.revoked_at_provider });
});
