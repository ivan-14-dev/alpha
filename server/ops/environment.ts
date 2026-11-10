import { connect } from 'node:net';
import { all, one } from '../db.js';
import { scannerConfig } from '../files/scan.js';
import { mailTransportConfigured } from '../platform/mailer.js';
import { paymentMode } from '../payments/mode.js';
import { dockerSettings, isRemoteDocker } from '../sandbox/docker.js';
import { backupDirectory, dataDirectory, diskSpace } from './runtime.js';
import { latestBackup } from './backup.js';

export type CheckStatus = 'ok' | 'warning' | 'error' | 'info';
export interface EnvironmentCheck { id: string; label: string; status: CheckStatus; detail: string }

const production = () => process.env.NODE_ENV === 'production';
const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/** ClamAV address as resolved by the files module (admin setting first, then CLAMAV_HOST/CLAMAV_PORT). */
export function clamavAddress(): { host: string; port: number; source: 'env' | 'settings' } | null {
  const config = scannerConfig();
  return config ? { host: config.host, port: config.port, source: config.source } : null;
}

/** clamd `zPING` → `PONG`. Short timeout: this runs while an admin waits for the page. */
export function clamavPing(host: string, port: number, timeoutMs = 2000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let reply = '';
    let settled = false;
    const socket = connect({ host, port });
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs, () => done(false, `aucune réponse en ${timeoutMs} ms`));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      if (reply.includes('PONG')) done(true, 'PONG');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => done(false, error.code ?? error.message));
    socket.on('close', () => done(reply.includes('PONG'), reply ? reply.replace(/\0/g, '').trim().slice(0, 100) : 'connexion fermée'));
  });
}

function originCheck(id: string, label: string, value: string | undefined, required: boolean): EnvironmentCheck {
  if (!value) {
    return { id, label, status: required && production() ? 'error' : 'warning', detail: 'Non défini.' };
  }
  if (!URL.canParse(value)) return { id, label, status: 'error', detail: `URL invalide : ${value}` };
  const url = new URL(value);
  if (url.protocol === 'https:') return { id, label, status: 'ok', detail: url.origin };
  return { id, label, status: production() && !isLocalHost(url.hostname) ? 'error' : 'warning', detail: `${url.origin} n’utilise pas HTTPS.` };
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 48 ? `${Math.floor(hours / 24)} jours` : hours >= 1 ? `${hours} h` : `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

/** Deployment checklist shown in the admin "Système" section. Never exposes secret values. */
export async function environmentChecks(): Promise<EnvironmentCheck[]> {
  const checks: EnvironmentCheck[] = [];

  checks.push(production()
    ? { id: 'node_env', label: 'Mode production', status: 'ok', detail: 'NODE_ENV=production (cookies Secure, journaux JSON).' }
    : { id: 'node_env', label: 'Mode production', status: 'info', detail: `NODE_ENV=${process.env.NODE_ENV ?? 'non défini'} : environnement de développement.` });

  const previousKeys = (process.env.ALPHA_SECRETS_KEY_PREVIOUS ?? '').split(',').filter((item) => item.trim()).length;
  checks.push(process.env.ALPHA_SECRETS_KEY
    ? { id: 'secrets_key', label: 'Clé de chiffrement des secrets', status: 'ok', detail: `ALPHA_SECRETS_KEY définie${previousKeys ? ` (${previousKeys} ancienne(s) clé(s) pour la rotation)` : ''}.` }
    : { id: 'secrets_key', label: 'Clé de chiffrement des secrets', status: production() ? 'error' : 'warning', detail: 'ALPHA_SECRETS_KEY absente : clé de développement générée à côté de la base.' });

  checks.push(originCheck('app_origin', 'Origine publique (APP_ORIGIN)', process.env.APP_ORIGIN, true));
  if (process.env.PUBLIC_API_ORIGIN) checks.push(originCheck('public_api_origin', 'Origine des webhooks (PUBLIC_API_ORIGIN)', process.env.PUBLIC_API_ORIGIN, false));

  const proxies = Number(process.env.TRUST_PROXY ?? 0);
  checks.push(proxies > 0
    ? { id: 'trust_proxy', label: 'Proxy inverse de confiance', status: 'ok', detail: `TRUST_PROXY=${proxies} : l’adresse IP client vient de X-Forwarded-For.` }
    : { id: 'trust_proxy', label: 'Proxy inverse de confiance', status: production() ? 'warning' : 'info', detail: 'TRUST_PROXY non défini : derrière Caddy, les limites de débit verraient l’adresse du proxy.' });

  checks.push(mailTransportConfigured()
    ? { id: 'smtp', label: 'Envoi des e-mails (SMTP)', status: 'ok', detail: process.env.SMTP_URL ? 'Configuré par SMTP_URL.' : 'Configuré dans l’administration.' }
    : { id: 'smtp', label: 'Envoi des e-mails (SMTP)', status: production() ? 'error' : 'warning', detail: production() ? 'Aucun transport : les e-mails restent en file d’attente.' : 'Aucun transport : les e-mails sont seulement journalisés.' });

  const clamav = clamavAddress();
  if (!clamav) {
    checks.push({ id: 'clamav', label: 'Antivirus ClamAV', status: production() ? 'warning' : 'info', detail: 'Non configuré ou désactivé (CLAMAV_HOST ou réglage du module Fichiers).' });
  } else {
    const ping = await clamavPing(clamav.host, clamav.port);
    checks.push({ id: 'clamav', label: 'Antivirus ClamAV', status: ping.ok ? 'ok' : 'error',
      detail: `${clamav.host}:${clamav.port} (${clamav.source === 'env' ? 'variable d’environnement' : 'réglage du module Fichiers'}) — ${ping.ok ? 'joignable' : `injoignable : ${ping.detail}`}.` });
  }

  const dockerHost = dockerSettings().host;
  const sandboxSettings = one<{ count: number }>("SELECT COUNT(*) AS count FROM platform_settings WHERE key LIKE 'sandbox.%'")?.count ?? 0;
  if (!dockerHost) {
    checks.push({ id: 'sandbox', label: 'Bac à sable (Docker distant)', status: 'info', detail: `ALPHA_SANDBOX_DOCKER_HOST non défini : exécution isolée indisponible${sandboxSettings ? ' (réglages présents)' : ''}.` });
  } else if (!isRemoteDocker(dockerHost) || /docker\.sock/.test(dockerHost)) {
    checks.push({ id: 'sandbox', label: 'Bac à sable (Docker distant)', status: production() ? 'error' : 'warning', detail: 'Démon Docker local (socket) : en production, utilisez un hôte Docker distant dédié (tcp+TLS).' });
  } else {
    const tls = dockerHost.startsWith('tcp://') && !dockerSettings().tlsVerify ? ' — TLS non vérifié (ALPHA_SANDBOX_DOCKER_TLS_VERIFY)' : '';
    checks.push({ id: 'sandbox', label: 'Bac à sable (Docker distant)', status: tls && production() ? 'warning' : 'ok', detail: `Hôte distant configuré (${dockerHost.replace(/\/\/[^@/]*@/, '//***@').split('?')[0]})${tls}.` });
  }

  const metricsToken = process.env.METRICS_TOKEN ?? '';
  checks.push(!metricsToken
    ? { id: 'metrics_token', label: 'Métriques Prometheus', status: 'info', detail: 'METRICS_TOKEN non défini : /api/system/metrics répond 404.' }
    : metricsToken.length < 24
      ? { id: 'metrics_token', label: 'Métriques Prometheus', status: 'warning', detail: 'METRICS_TOKEN trop court (24 caractères minimum) : métriques désactivées.' }
      : { id: 'metrics_token', label: 'Métriques Prometheus', status: 'ok', detail: 'Jeton défini : /api/system/metrics accessible avec Authorization: Bearer.' });

  checks.push(process.env.ALPHA_JOBS === 'off'
    ? { id: 'jobs', label: 'Tâches planifiées', status: 'warning', detail: 'ALPHA_JOBS=off : aucune tâche ne s’exécute sur cette instance.' }
    : { id: 'jobs', label: 'Tâches planifiées', status: 'ok', detail: 'Actives sur cette instance.' });

  const latest = latestBackup();
  if (!latest) {
    checks.push({ id: 'backups', label: 'Sauvegardes', status: production() ? 'error' : 'warning', detail: `Aucune sauvegarde dans ${backupDirectory()}.` });
  } else {
    const age = Date.now() - Date.parse(latest.created_at);
    checks.push({ id: 'backups', label: 'Sauvegardes', status: age > 26 * 3_600_000 ? 'error' : 'ok',
      detail: `Dernière sauvegarde il y a ${formatAge(age)} (${latest.id}). Copiez-les hors du serveur (restic, rclone).` });
  }

  const disk = diskSpace(dataDirectory());
  if (disk && disk.total_bytes > 0) {
    const ratio = disk.free_bytes / disk.total_bytes;
    checks.push({ id: 'disk', label: 'Espace disque des données', status: ratio < 0.1 ? 'error' : ratio < 0.2 ? 'warning' : 'ok',
      detail: `${Math.round(ratio * 100)} % libre (${(disk.free_bytes / 1e9).toFixed(1)} Go).` });
  }

  const mode = paymentMode();
  const liveProblems = mode === 'live' ? [
    !process.env.ALPHA_SECRETS_KEY && 'ALPHA_SECRETS_KEY',
    !(process.env.APP_ORIGIN ?? '').startsWith('https://') && 'APP_ORIGIN en HTTPS',
    !production() && 'NODE_ENV=production',
  ].filter(Boolean) : [];
  checks.push({ id: 'payment_mode', label: 'Mode de paiement', status: liveProblems.length ? 'error' : mode === 'live' ? 'ok' : 'info',
    detail: liveProblems.length ? `Mode réel sans : ${liveProblems.join(', ')}.` : mode === 'demo' ? 'Démonstration : aucun argent réel.' : mode === 'sandbox' ? 'Bac à sable des prestataires : aucun argent réel.' : 'Paiements réels actifs.' });

  const journal = all<{ journal_mode: string }>('PRAGMA journal_mode')[0]?.journal_mode;
  checks.push({ id: 'sqlite', label: 'Base SQLite', status: journal === 'wal' || journal === 'memory' ? 'ok' : 'warning', detail: `Journal ${journal ?? 'inconnu'} ; nœud unique (pas de réplication).` });

  return checks;
}
