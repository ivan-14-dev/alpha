import { all, one, run, transaction } from '../db.js';
import { now } from '../core.js';
import { registerJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { groupKey, riskLevelOf, shortHash, upsertCase, type CaseInput } from './cases.js';
import { blockingSanction, createSanction } from './sanctions.js';
import {
  autoActions, DAY_MS, HOUR_MS, isoAgo, signalRetentionDays, thresholds, trustRetention, type Thresholds,
} from './settings.js';

/**
 * Anti-abuse detectors. Each one turns indexed SQL aggregates into risk cases through `upsertCase`
 * (idempotent dedupe keys). They never sanction anybody: an optional, opt-in automatic measure can only
 * hold withdrawals of high-risk accounts, pending human review.
 */
export interface DetectionTally { created: number; updated: number; touched: Set<string>; auto_holds: number }
const newTally = (): DetectionTally => ({ created: 0, updated: 0, touched: new Set(), auto_holds: 0 });

function track(tally: DetectionTally, input: CaseInput) {
  const result = upsertCase(input);
  if (!result) return;
  if (result.created) tally.created += 1;
  else if (result.changed) tally.updated += 1;
  if (result.changed) tally.touched.add(result.id);
}

const tableExists = (name: string) => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
const splitIds = (value: string | null) => [...new Set((value ?? '').split(',').filter(Boolean))];
const placeholders = (values: unknown[]) => values.map(() => '?').join(',');

/** Newest account first: duplicates are usually the most recent registrations. */
function newestFirst(userIds: string[]): string[] {
  if (!userIds.length) return [];
  return all<{ id: string }>(`SELECT id FROM users WHERE id IN (${placeholders(userIds)}) ORDER BY created_at DESC,id`, ...userIds).map((row) => row.id);
}

/** Hashes seen for both users since `since`. Private/CGNAT addresses are never used for IP matching. */
export function sharedHashes(column: 'device_hash' | 'ip_hash', left: string, right: string, since: string): string[] {
  const scope = column === 'ip_hash' ? "AND x.ip_scope='public'" : '';
  return all<{ hash: string }>(`SELECT DISTINCT x.${column} AS hash FROM risk_signals x
    WHERE x.user_id=? AND x.${column} IS NOT NULL ${scope} AND x.created_at>=?
    AND EXISTS (SELECT 1 FROM risk_signals y WHERE y.${column}=x.${column} AND y.user_id=? AND y.created_at>=?) LIMIT 10`,
  left, since, right, since).map((row) => row.hash);
}

export function detectSharedDevices(t: Thresholds, tally: DetectionTally, deviceHash?: string) {
  const since = isoAgo(t.window_days * DAY_MS);
  const rows = all<{ device_hash: string; users: string; accounts: number; first_seen: string; last_seen: string }>(
    `SELECT device_hash,GROUP_CONCAT(DISTINCT user_id) AS users,COUNT(DISTINCT user_id) AS accounts,MIN(created_at) AS first_seen,MAX(created_at) AS last_seen
     FROM risk_signals WHERE device_hash IS NOT NULL AND user_id IS NOT NULL AND created_at>=? ${deviceHash ? 'AND device_hash=?' : ''}
     GROUP BY device_hash HAVING COUNT(DISTINCT user_id)>=? ORDER BY accounts DESC LIMIT 500`,
    since, ...(deviceHash ? [deviceHash] : []), t.multi_account_device_users);
  for (const row of rows) {
    const [primary, ...related] = newestFirst(splitIds(row.users));
    if (!primary) continue;
    track(tally, {
      kind: 'multi_account', userId: primary, related,
      score: row.accounts >= 3 ? Math.min(95, 70 + (row.accounts - 3) * 8) : 55,
      summary: `${row.accounts} comptes utilisent le même appareil (empreinte ${shortHash(row.device_hash)}) sur ${t.window_days} jours.`,
      evidence: { pattern: 'shared_device', device_hash: shortHash(row.device_hash), accounts: row.accounts, first_seen: row.first_seen, last_seen: row.last_seen, window_days: t.window_days },
      dedupeKey: `multi_account:device:${row.device_hash}`,
    });
  }
}

export function detectIpRegistrations(t: Thresholds, tally: DetectionTally, ipHash?: string) {
  const since = isoAgo(DAY_MS);
  const rows = all<{ ip_hash: string; users: string; accounts: number; first_seen: string; last_seen: string }>(
    `SELECT ip_hash,GROUP_CONCAT(DISTINCT user_id) AS users,COUNT(DISTINCT user_id) AS accounts,MIN(created_at) AS first_seen,MAX(created_at) AS last_seen
     FROM risk_signals WHERE kind='register' AND ip_scope='public' AND ip_hash IS NOT NULL AND user_id IS NOT NULL AND created_at>=? ${ipHash ? 'AND ip_hash=?' : ''}
     GROUP BY ip_hash HAVING COUNT(DISTINCT user_id)>=? ORDER BY accounts DESC LIMIT 500`,
    since, ...(ipHash ? [ipHash] : []), t.ip_registrations_per_day);
  for (const row of rows) {
    const [primary, ...related] = newestFirst(splitIds(row.users));
    if (!primary) continue;
    track(tally, {
      kind: 'multi_account', userId: primary, related,
      score: Math.min(60, 40 + (row.accounts - t.ip_registrations_per_day) * 5),
      summary: `${row.accounts} inscriptions depuis la même adresse IP (empreinte ${shortHash(row.ip_hash)}) en 24 h. Peut être un réseau partagé.`,
      evidence: { pattern: 'ip_registrations', ip_hash: shortHash(row.ip_hash), accounts: row.accounts, first_seen: row.first_seen, last_seen: row.last_seen, window_hours: 24 },
      dedupeKey: `multi_account:ip:${row.ip_hash}`,
    });
  }
}

function pairEvidence(left: string, right: string, since: string) {
  const devices = sharedHashes('device_hash', left, right, since);
  const ips = sharedHashes('ip_hash', left, right, since);
  return { devices, ips, base: devices.length ? 75 : ips.length ? 50 : 0 };
}

export function detectCollusion(t: Thresholds, tally: DetectionTally, pair?: { owner: string; tester: string }) {
  const since = isoAgo(t.collusion_window_days * DAY_MS);
  const rows = all<{ owner_id: string; tester_id: string; paid: number; missions: string; last_paid: string }>(
    `SELECT c.owner_id,m.tester_id,COUNT(*) AS paid,GROUP_CONCAT(m.id) AS missions,MAX(m.updated_at) AS last_paid
     FROM missions m JOIN campaigns c ON c.id=m.campaign_id
     WHERE m.status='paid' AND m.updated_at>=? AND c.owner_id!=m.tester_id ${pair ? 'AND c.owner_id=? AND m.tester_id=?' : ''}
     GROUP BY c.owner_id,m.tester_id ORDER BY paid DESC LIMIT 2000`, since, ...(pair ? [pair.owner, pair.tester] : []));
  for (const row of rows) {
    const shared = pairEvidence(row.owner_id, row.tester_id, since);
    const repeated = row.paid >= t.collusion_repeat_payouts;
    if (!shared.base && !repeated) continue;
    const score = shared.base
      ? Math.min(95, shared.base + (repeated ? 10 : 0))
      : Math.min(65, 45 + (row.paid - t.collusion_repeat_payouts) * 5);
    const reasons = [
      shared.devices.length ? 'partagent un appareil' : shared.ips.length ? 'partagent une adresse IP' : '',
      repeated ? `${row.paid} versements du même propriétaire au même testeur` : '',
    ].filter(Boolean);
    track(tally, {
      kind: 'collusion', userId: row.tester_id, related: [row.owner_id], score,
      summary: `Propriétaire de campagne et testeur payé : ${reasons.join(' ; ')} (${t.collusion_window_days} jours).`,
      evidence: {
        pattern: 'owner_tester', owner_id: row.owner_id, tester_id: row.tester_id, paid_missions: row.paid,
        mission_ids: splitIds(row.missions).slice(0, 20), last_paid: row.last_paid,
        shared_devices: shared.devices.map(shortHash), shared_ips: shared.ips.map(shortHash),
      },
      dedupeKey: `collusion:${row.owner_id}:${row.tester_id}`,
    });
  }
}

export function detectSelfDealing(t: Thresholds, tally: DetectionTally, pair?: { seller: string; buyer: string }) {
  const since = isoAgo(t.collusion_window_days * DAY_MS);
  const rows = all<{ seller_id: string; buyer_id: string; orders: number; order_ids: string; last_order: string }>(
    `SELECT seller_id,buyer_id,COUNT(*) AS orders,GROUP_CONCAT(id) AS order_ids,MAX(created_at) AS last_order FROM orders
     WHERE created_at>=? AND buyer_id!=seller_id ${pair ? 'AND seller_id=? AND buyer_id=?' : ''}
     GROUP BY seller_id,buyer_id ORDER BY orders DESC LIMIT 2000`, since, ...(pair ? [pair.seller, pair.buyer] : []));
  for (const row of rows) {
    const shared = pairEvidence(row.seller_id, row.buyer_id, since);
    if (!shared.base) continue;
    track(tally, {
      kind: 'self_dealing', userId: row.seller_id, related: [row.buyer_id],
      score: Math.min(90, shared.base + (row.orders - 1) * 5),
      summary: `Acheteur et vendeur ${shared.devices.length ? 'partagent un appareil' : 'partagent une adresse IP'} (${row.orders} commande${row.orders > 1 ? 's' : ''}).`,
      evidence: {
        pattern: 'buyer_seller', seller_id: row.seller_id, buyer_id: row.buyer_id, orders: row.orders,
        order_ids: splitIds(row.order_ids).slice(0, 20), last_order: row.last_order,
        shared_devices: shared.devices.map(shortHash), shared_ips: shared.ips.map(shortHash),
      },
      dedupeKey: `self_dealing:${row.seller_id}:${row.buyer_id}`,
    });
  }
}

/** Union-find over reciprocal "I test yours, you test mine" positive reviews. */
export function detectReviewRings(t: Thresholds, tally: DetectionTally) {
  const since = isoAgo(t.review_window_days * DAY_MS);
  const pairs = all<{ left_id: string; right_id: string; reviews: string }>(
    `WITH positive AS (
       SELECT r.id,r.author_id,r.subject_id,r.mission_id,c.owner_id FROM reviews r
       JOIN missions m ON m.id=r.mission_id JOIN campaigns c ON c.id=m.campaign_id
       WHERE r.rating>=4 AND r.created_at>=? AND r.author_id!=r.subject_id)
     SELECT p1.author_id AS left_id,p1.subject_id AS right_id,GROUP_CONCAT(DISTINCT p1.id)||','||GROUP_CONCAT(DISTINCT p2.id) AS reviews
     FROM positive p1 JOIN positive p2 ON p2.author_id=p1.subject_id AND p2.subject_id=p1.author_id AND p2.owner_id!=p1.owner_id
     WHERE p1.author_id<p1.subject_id GROUP BY p1.author_id,p1.subject_id LIMIT 5000`, since);
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let current = node; parent.get(current) !== root;) { const next = parent.get(current)!; parent.set(current, root); current = next; }
    return root;
  };
  for (const pair of pairs) {
    for (const node of [pair.left_id, pair.right_id]) if (!parent.has(node)) parent.set(node, node);
    const [left, right] = [find(pair.left_id), find(pair.right_id)];
    if (left !== right) parent.set(left, right);
  }
  const components = new Map<string, { members: Set<string>; pairs: number; reviews: Set<string> }>();
  for (const pair of pairs) {
    const root = find(pair.left_id);
    const component = components.get(root) ?? { members: new Set(), pairs: 0, reviews: new Set() };
    component.members.add(pair.left_id).add(pair.right_id);
    component.pairs += 1;
    for (const reviewId of splitIds(pair.reviews)) component.reviews.add(reviewId);
    components.set(root, component);
  }
  for (const component of components.values()) {
    const members = newestFirst([...component.members]);
    if (members.length < 2) continue;
    const newcomers = all<{ id: string }>(`SELECT u.id FROM users u WHERE u.id IN (${placeholders(members)})
      AND julianday((SELECT MIN(r.created_at) FROM reviews r WHERE r.author_id=u.id AND r.rating>=4 AND r.created_at>=?)) - julianday(u.created_at) < ?`,
    ...members, since, t.new_account_days).length;
    const base = members.length >= 3 ? Math.min(90, 60 + (members.length - 3) * 8) : 45;
    const [primary, ...related] = members;
    track(tally, {
      kind: 'review_ring', userId: primary, related,
      score: Math.min(95, base + (newcomers >= 2 ? 10 : 0)),
      summary: `${members.length} membres échangent des avis positifs réciproques (${component.pairs} paire${component.pairs > 1 ? 's' : ''} croisée${component.pairs > 1 ? 's' : ''}).`,
      evidence: { pattern: 'reciprocal', members: members.length, reciprocal_pairs: component.pairs, new_accounts: newcomers, review_ids: [...component.reviews].slice(0, 30), window_days: t.review_window_days },
      dedupeKey: `review_ring:${groupKey(members)}`,
      matchOverlap: true,
    });
  }
  const bursts = all<{ subject_id: string; reviews: number; authors: string; review_ids: string; first_at: string; last_at: string }>(
    `SELECT r.subject_id,COUNT(*) AS reviews,GROUP_CONCAT(DISTINCT r.author_id) AS authors,GROUP_CONCAT(r.id) AS review_ids,MIN(r.created_at) AS first_at,MAX(r.created_at) AS last_at
     FROM reviews r JOIN users a ON a.id=r.author_id
     WHERE r.rating>=4 AND r.created_at>=? AND julianday(r.created_at)-julianday(a.created_at)<?
     GROUP BY r.subject_id HAVING COUNT(*)>=? LIMIT 500`, isoAgo(t.review_burst_hours * HOUR_MS), t.new_account_days, t.review_burst_count);
  for (const burst of bursts) {
    track(tally, {
      kind: 'review_ring', userId: burst.subject_id, related: splitIds(burst.authors), score: 65,
      summary: `${burst.reviews} avis positifs reçus en ${t.review_burst_hours} h de comptes créés depuis moins de ${t.new_account_days} jours.`,
      evidence: { pattern: 'burst', reviews: burst.reviews, authors: splitIds(burst.authors).length, review_ids: splitIds(burst.review_ids).slice(0, 30), first_at: burst.first_at, last_at: burst.last_at, window_hours: t.review_burst_hours },
      dedupeKey: `review_ring:burst:${burst.subject_id}`,
    });
  }
}

export function detectVelocity(t: Thresholds, tally: DetectionTally) {
  const failures = all<{ user_id: string; attempts: number; sources: number }>(
    `SELECT user_id,COUNT(*) AS attempts,COUNT(DISTINCT ip_hash) AS sources FROM risk_signals
     WHERE kind IN ('login_failed','mfa_failed') AND user_id IS NOT NULL AND created_at>=?
     GROUP BY user_id HAVING COUNT(*)>=? LIMIT 1000`, isoAgo(HOUR_MS), t.failed_logins_per_hour);
  for (const row of failures) {
    track(tally, {
      kind: 'velocity', userId: row.user_id, related: [], score: 45,
      summary: `${row.attempts} échecs de connexion ou de MFA en une heure (${row.sources} source${row.sources > 1 ? 's' : ''}) : compte possiblement ciblé.`,
      evidence: { pattern: 'failed_auth', attempts: row.attempts, sources: row.sources, window_hours: 1 },
      dedupeKey: `velocity:auth:${row.user_id}`,
    });
  }
  const hours = t.withdrawal_after_funding_hours;
  const since = isoAgo(7 * DAY_MS);
  const quick = new Map<string, number>();
  for (const row of all<{ user_id: string; withdrawals: number }>(
    `SELECT w.user_id,COUNT(DISTINCT w.id) AS withdrawals FROM risk_signals w
     WHERE w.kind='withdrawal' AND w.user_id IS NOT NULL AND w.created_at>=? AND EXISTS (
       SELECT 1 FROM risk_signals p WHERE p.user_id=w.user_id AND p.kind='payment' AND p.created_at<=w.created_at
       AND julianday(w.created_at)-julianday(p.created_at)<=?/24.0 AND COALESCE(json_extract(p.meta,'$.status'),'succeeded')!='failed')
     GROUP BY w.user_id`, since, hours)) quick.set(row.user_id, row.withdrawals);
  if (tableExists('withdrawals') && tableExists('payment_intents')) {
    for (const row of all<{ user_id: string; withdrawals: number }>(
      `SELECT w.user_id,COUNT(DISTINCT w.id) AS withdrawals FROM withdrawals w WHERE w.created_at>=? AND EXISTS (
         SELECT 1 FROM payment_intents p WHERE p.user_id=w.user_id AND p.status='succeeded' AND p.updated_at<=w.created_at
         AND julianday(w.created_at)-julianday(p.updated_at)<=?/24.0)
       GROUP BY w.user_id`, since, hours)) quick.set(row.user_id, Math.max(quick.get(row.user_id) ?? 0, row.withdrawals));
  }
  for (const [userId, withdrawals] of quick) {
    track(tally, {
      kind: 'velocity', userId, related: [], score: 50,
      summary: `Retrait demandé moins de ${hours} h après un paiement entrant du même compte.`,
      evidence: { pattern: 'withdrawal_after_funding', withdrawals, window_hours: hours },
      dedupeKey: `velocity:withdrawal:${userId}`,
    });
  }
}

export function detectPaymentFailures(t: Thresholds, tally: DetectionTally) {
  const since = isoAgo(DAY_MS);
  const counts = new Map<string, number>();
  for (const row of all<{ user_id: string; failures: number }>(
    `SELECT user_id,COUNT(*) AS failures FROM risk_signals WHERE kind='payment' AND user_id IS NOT NULL AND created_at>=?
     AND json_extract(meta,'$.status')='failed' GROUP BY user_id`, since)) counts.set(row.user_id, row.failures);
  if (tableExists('payment_intents')) {
    for (const row of all<{ user_id: string; failures: number }>(
      "SELECT user_id,COUNT(*) AS failures FROM payment_intents WHERE status='failed' AND updated_at>=? GROUP BY user_id", since)) {
      counts.set(row.user_id, Math.max(counts.get(row.user_id) ?? 0, row.failures));
    }
  }
  for (const [userId, failures] of counts) {
    if (failures < t.payment_failures_per_day) continue;
    track(tally, {
      kind: 'payment_fraud', userId, related: [], score: Math.min(80, 50 + (failures - t.payment_failures_per_day) * 3),
      summary: `${failures} paiements échoués en 24 h (test de cartes ou de comptes mobile money possible).`,
      evidence: { pattern: 'payment_failures', failures, window_hours: 24 },
      dedupeKey: `payment_fraud:failures:${userId}`,
    });
  }
}

const HOLD_REASON = 'Vos retraits sont suspendus à titre conservatoire pendant l’examen d’une alerte de sécurité concernant votre compte. Aucune faute n’est présumée à ce stade.';

/** Opt-in (`trust.auto_actions`): hold withdrawals of high-risk members. Never re-applied after a human lifted it. */
export function applyAutomaticHolds(tally: DetectionTally) {
  const settings = autoActions();
  if (!settings.hold_withdrawals_on_high_risk) return;
  const candidates = all<{ user_id: string; case_id: string }>(`SELECT cs.user_id,c.id AS case_id FROM risk_cases c
    JOIN risk_case_subjects cs ON cs.case_id=c.id JOIN users u ON u.id=cs.user_id
    WHERE c.status IN ('open','reviewing') AND c.score>=70 AND u.role!='admin' ORDER BY c.score DESC,c.created_at LIMIT 500`);
  const handled = new Set<string>();
  for (const candidate of candidates) {
    if (handled.has(candidate.user_id)) continue;
    handled.add(candidate.user_id);
    if (riskLevelOf(candidate.user_id) !== 'high' || blockingSanction(candidate.user_id, 'withdraw')) continue;
    if (one('SELECT 1 FROM sanctions WHERE user_id=? AND case_id=? AND automated=1', candidate.user_id, candidate.case_id)) continue;
    createSanction({
      userId: candidate.user_id, kind: 'restriction', capabilities: ['withdraw'], publicReason: HOLD_REASON,
      internalNote: 'Mesure automatique (trust.auto_actions.hold_withdrawals_on_high_risk).', ground: 'terms.security',
      endsAt: new Date(Date.now() + settings.hold_days * DAY_MS).toISOString(), appealable: true,
      createdBy: null, caseId: candidate.case_id, automated: true,
    });
    tally.auto_holds += 1;
  }
}

const detectors: [string, (t: Thresholds, tally: DetectionTally) => void][] = [
  ['shared_devices', (t, tally) => detectSharedDevices(t, tally)],
  ['ip_registrations', (t, tally) => detectIpRegistrations(t, tally)],
  ['collusion', (t, tally) => detectCollusion(t, tally)],
  ['review_rings', detectReviewRings],
  ['velocity', detectVelocity],
  ['payment_failures', detectPaymentFailures],
  ['self_dealing', (t, tally) => detectSelfDealing(t, tally)],
];

export interface DetectionSummary { created: number; updated: number; auto_holds: number; failed: string[]; at: string }
let lastSummary: DetectionSummary | null = null;
/** Summary of the last full scan in this process (admin "run now" feedback). */
export const lastDetection = () => lastSummary;

/** Full scan (job `trust.detect`). Each detector commits separately so one failure never blocks the others. */
export function runDetectors(): DetectionSummary {
  const t = thresholds();
  const tally = newTally();
  const failed: string[] = [];
  for (const [name, detector] of detectors) {
    try { transaction(() => detector(t, tally)); } catch (error) {
      failed.push(name);
      log.error('trust.detector_failed', { detector: name, error });
    }
  }
  try { transaction(() => applyAutomaticHolds(tally)); } catch (error) {
    failed.push('auto_holds');
    log.error('trust.auto_hold_failed', { error });
  }
  const summary = { created: tally.created, updated: tally.updated, auto_holds: tally.auto_holds, failed, at: now() };
  lastSummary = summary;
  if (tally.created || tally.updated || tally.auto_holds) log.info('trust.detection', summary);
  if (failed.length) throw new Error(`Détecteurs en échec : ${failed.join(', ')}`);
  return summary;
}

/** Cheap checks run inline by recordSignal / domain hooks for one hash or one pair (no automatic measure). */
export function inlineSignalDetection(kind: string, hashes: { device_hash: string | null; ip_hash: string | null; ip_scope: string }) {
  const t = thresholds();
  const tally = newTally();
  if (hashes.device_hash && kind !== 'message') detectSharedDevices(t, tally, hashes.device_hash);
  if (kind === 'register' && hashes.ip_hash && hashes.ip_scope === 'public') detectIpRegistrations(t, tally, hashes.ip_hash);
}

export function inlineOrderDetection(orderId: string) {
  const order = one<{ seller_id: string; buyer_id: string }>('SELECT seller_id,buyer_id FROM orders WHERE id=?', orderId);
  if (order && order.seller_id !== order.buyer_id) detectSelfDealing(thresholds(), newTally(), { seller: order.seller_id, buyer: order.buyer_id });
}

export function inlineMissionDetection(missionId: string) {
  const mission = one<{ owner_id: string; tester_id: string }>('SELECT c.owner_id,m.tester_id FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?', missionId);
  if (mission && mission.owner_id !== mission.tester_id) detectCollusion(thresholds(), newTally(), { owner: mission.owner_id, tester: mission.tester_id });
}

/** Retention: signals (privacy.retention.risk_signals_days), dismissed cases, expired sanctions + their appeals. */
export function purgeTrustData() {
  const retention = trustRetention();
  const signalsBefore = isoAgo(signalRetentionDays() * DAY_MS);
  const dismissedBefore = isoAgo(retention.dismissed_cases_days * DAY_MS);
  const sanctionsBefore = isoAgo(retention.sanctions_years * 365 * DAY_MS);
  return transaction(() => ({
    signals: Number(run('DELETE FROM risk_signals WHERE created_at<?', signalsBefore).changes),
    dismissed_cases: Number(run("DELETE FROM risk_cases WHERE status='dismissed' AND resolved_at<?", dismissedBefore).changes),
    actioned_cases: Number(run("DELETE FROM risk_cases WHERE status='actioned' AND resolved_at<?", sanctionsBefore).changes),
    sanctions: Number(run('DELETE FROM sanctions WHERE COALESCE(revoked_at,ends_at) IS NOT NULL AND COALESCE(revoked_at,ends_at)<?', sanctionsBefore).changes),
  }));
}

registerJob({
  name: 'trust.detect',
  description: 'Détecte multi-comptes, collusion, cercles d’avis, vélocité, fraude au paiement et auto-transactions.',
  intervalMs: 10 * 60000,
  run: () => { runDetectors(); },
});

registerJob({
  name: 'trust.purge',
  description: 'Purge les signaux de risque expirés, les dossiers classés anciens et les sanctions archivées.',
  intervalMs: DAY_MS,
  run: () => { const purged = purgeTrustData(); log.info('trust.purge', purged); },
});
