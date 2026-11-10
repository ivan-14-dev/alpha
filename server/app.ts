import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachUser, authRouter } from './auth.js';
import { errorHandler, HttpError } from './core.js';
import dashboard from './dashboard.js';
import projects from './modules/projects.js';
import testing from './modules/testing.js';
import community from './modules/community.js';
import marketplace from './modules/marketplace.js';
import payments from './modules/payments.js';
import people from './modules/people.js';
import reputation from './modules/reputation.js';
import communication from './modules/communication.js';
import trust from './modules/trust.js';
import integrations from './modules/integrations.js';
import network from './modules/network.js';
import workspace from './modules/workspace.js';
import discovery from './modules/discovery.js';
import files from './modules/files.js';
import sandbox from './modules/sandbox.js';
import realtime from './modules/realtime.js';
import compliance from './modules/compliance.js';
import privacy from './modules/privacy.js';
import system from './modules/system.js';
import { capabilityMiddleware } from './platform/guards.js';
import { observability } from './ops/observability.js';
import { paymentMode } from './payments/mode.js';
import './platform/mailer.js';
import './platform/rateLimit.js';

export const APP_VERSION = '0.4.0';
/** External callers (payment providers, GitHub/GitLab/Figma) post here without the browser CSRF header. */
export const webhookPrefixes = ['/api/payments/webhooks/', '/api/integrations/webhooks/'];

export const app = express();
app.disable('x-powered-by');
// TRUST_PROXY: number of reverse proxies in front of the app (e.g. 1 behind Caddy/nginx). Never `true`.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(observability);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !webhookPrefixes.some((prefix) => req.originalUrl.startsWith(prefix))) {
    if (req.headers['x-alpha-client'] !== 'web') throw new HttpError(403, 'Requete non autorisee.');
    const allowed = process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3001', 'http://localhost:3001'];
    if (req.headers.origin && !allowed.includes(req.headers.origin)) throw new HttpError(403, 'Origine non autorisee.');
  }
  next();
});
// Webhook handlers receive the raw Buffer in req.body to verify signatures before parsing.
app.use(webhookPrefixes.map((prefix) => prefix.slice(0, -1)), express.raw({ type: () => true, limit: '2mb' }));
app.use(express.json({ limit: '128kb' }));
app.use(attachUser);
app.use(capabilityMiddleware);
app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: APP_VERSION, payment_mode: paymentMode() }));
app.use('/api/auth', authRouter);
app.use('/api/dashboard', dashboard);
app.use('/api/projects', projects);
app.use('/api/testing', testing);
app.use('/api/community', community);
app.use('/api/marketplace', marketplace);
app.use('/api/payments', payments);
app.use('/api/people', people);
app.use('/api/reputation', reputation);
app.use('/api/communication', communication);
app.use('/api/trust', trust);
app.use('/api/integrations', integrations);
app.use('/api/network', network);
app.use('/api/workspace', workspace);
app.use('/api/discovery', discovery);
app.use('/api/files', files);
app.use('/api/sandbox', sandbox);
app.use('/api/realtime', realtime);
app.use('/api/compliance', compliance);
app.use('/api/privacy', privacy);
app.use('/api/system', system);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Route introuvable.')));
const build = resolve('dist');
if (existsSync(resolve(build, 'index.html'))) {
  app.get('/sw.js', (_req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });
  app.use(express.static(build));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(build, 'index.html')));
}
app.use(errorHandler);
