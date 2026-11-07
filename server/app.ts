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

export const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.headers['x-alpha-client'] !== 'web') throw new HttpError(403, 'Requete non autorisee.');
    const allowed = process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3001', 'http://localhost:3001'];
    if (req.headers.origin && !allowed.includes(req.headers.origin)) throw new HttpError(403, 'Origine non autorisee.');
  }
  next();
});
app.use(express.json({ limit: '128kb' }));
app.use(attachUser);
app.get('/api/health', (_req, res) => res.json({ status: 'ok', payment_mode: 'demo' }));
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
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Route introuvable.')));
const build = resolve('dist');
if (existsSync(resolve(build, 'index.html'))) {
  app.use(express.static(build));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(build, 'index.html')));
}
app.use(errorHandler);
