import { app } from './app.js';
import { db } from './db.js';
import { startJobs, stopJobs } from './platform/jobs.js';
import { log } from './platform/log.js';
import { assertSecretsReady } from './platform/secrets.js';
import { closeAllStreams } from './realtime/sse.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) throw new Error('APP_ORIGIN est requis en production.');
assertSecretsReady();
const host = process.env.HOST ?? '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`Alpha API: http://${host}:${port}`);
  if (process.env.ALPHA_JOBS !== 'off') startJobs();
});
// Campaign builds may reach 200 MB: give slow uplinks 30 min to finish streaming an upload (bodies go to disk, not memory).
server.requestTimeout = 30 * 60_000;
server.headersTimeout = 65_000;

/** In-flight requests get this long after SIGTERM; below Docker's default 10 s stop timeout (compose allows 20 s). */
const shutdownGraceMs = 8000;
let stopping = false;
function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  log.info('server.stopping', { signal });
  stopJobs();
  // Realtime streams never end on their own; browsers reconnect after the restart.
  closeAllStreams();
  const force = setTimeout(() => {
    log.warn('server.shutdown_forced', { grace_ms: shutdownGraceMs });
    server.closeAllConnections();
  }, shutdownGraceMs);
  force.unref();
  server.close((error) => {
    clearTimeout(force);
    if (error) { log.error('server.close_failed', { error }); process.exitCode = 1; }
    // Checkpoints the WAL so the volume holds a single consistent file; jobs still awaiting I/O are abandoned.
    try { db.close(); } catch (closeError) { log.warn('db.close_failed', { error: closeError }); }
    log.info('server.stopped');
    process.exit();
  });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
