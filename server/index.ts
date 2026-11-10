import { app } from './app.js';
import { startJobs, stopJobs } from './platform/jobs.js';
import { assertSecretsReady } from './platform/secrets.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) throw new Error('APP_ORIGIN est requis en production.');
assertSecretsReady();
const host = process.env.HOST ?? '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`Alpha API: http://${host}:${port}`);
  if (process.env.ALPHA_JOBS !== 'off') startJobs();
});
function shutdown() {
  stopJobs();
  server.close((error) => { if (error) { console.error(error); process.exitCode = 1; } });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
