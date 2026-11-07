import { app } from './app.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) throw new Error('APP_ORIGIN est requis en production.');
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Alpha API: http://127.0.0.1:${port} — paiements en mode demonstration uniquement`);
});
function shutdown() {
  server.close((error) => { if (error) { console.error(error); process.exitCode = 1; } });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
