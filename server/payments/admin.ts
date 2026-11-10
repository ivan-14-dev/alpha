import { Router } from 'express';
import { z } from 'zod';
import { all, one, transaction } from '../db.js';
import { audit, HttpError, id, param, requireAdmin } from '../core.js';
import { appOrigin, setSetting } from '../platform/settings.js';
import { describeProviderConfig, readProviderConfig, saveProviderConfig, webhookUrl } from './config.js';
import { ledgerAccounts, ledgerIsBalanced, postJournal } from './ledger.js';
import { BASE_CURRENCY_SETTING, baseCurrency, currencyExponent, FX_SETTING, fxRates, PAYMENT_MODE_SETTING, paymentMode, type PaymentMode } from './mode.js';
import { listProviders } from './providers/index.js';
import { FEES_SETTING, feeSettings, feesSchema } from './core/fees.js';
import { retryRefund } from './core/refunds.js';
import { adminIntent, getIntent, getRefund, type IntentRow, type RefundRow } from './core/store.js';
import { refreshIntent } from './intents.js';
import { reconcileIntent } from './core/reconcile.js';

/** Admin console API (mounted at /api/payments/admin). Every route requires an administrator; every mutation is audited. */
const router = Router();

export const LIVE_CONFIRMATION = 'ACTIVER LE MODE RÉEL';
const resourceId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const environment = z.enum(['sandbox', 'live']);
const currencyCode = z.string().regex(/^[A-Z]{3}$/).refine((code) => Object.hasOwn(currencyExponent, code), 'Devise non prise en charge.');
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};

/** Problems blocking the switch to live (empty = ready). */
export function liveReadiness(): string[] {
  const problems: string[] = [];
  if (!appOrigin().startsWith('https://')) problems.push('APP_ORIGIN doit être une URL HTTPS publique.');
  if (!process.env.ALPHA_SECRETS_KEY) problems.push('La variable ALPHA_SECRETS_KEY doit être définie (chiffrement des secrets prestataires).');
  const ready = listProviders().filter((provider) => {
    if (provider.id === 'simulator' || !provider.capabilities.collect) return false;
    const config = readProviderConfig(provider.id, 'live');
    return !!config && provider.validateConfig(config).length === 0;
  });
  if (!ready.length) problems.push('Aucun prestataire réel n’est activé et valide pour l’environnement live.');
  return problems;
}

function balancesByAccount(pattern: string) {
  return all<{ mode: string; currency: string; total: number }>(
    `SELECT mode,currency,COALESCE(SUM(amount_minor),0) AS total FROM ledger_entries WHERE account LIKE ? GROUP BY mode,currency ORDER BY mode,currency`, pattern);
}

function escrowHeld(mode?: PaymentMode) {
  return balancesByAccount('escrow:%').filter((row) => row.total !== 0 && (!mode || row.mode === mode));
}

router.get('/overview', (req, res) => {
  requireAdmin(req);
  const mode = paymentMode();
  const count = (sql: string, ...params: string[]) => one<{ total: number }>(sql, ...params)!.total;
  res.json({
    mode,
    base_currency: baseCurrency(),
    fees: feeSettings(),
    ledger_balanced: ledgerIsBalanced(),
    volumes: all(`SELECT mode,currency,purpose,COUNT(*) AS count,COALESCE(SUM(amount_minor),0) AS amount_minor,COALESCE(SUM(amount_base_minor),0) AS amount_base_minor
      FROM payment_intents WHERE settlement='settled' GROUP BY mode,currency,purpose ORDER BY mode,currency,purpose`),
    intents_by_status: all('SELECT mode,status,COUNT(*) AS count FROM payment_intents GROUP BY mode,status ORDER BY mode,status'),
    escrow: escrowHeld(),
    platform_fees: balancesByAccount(ledgerAccounts.platformFees()),
    member_balances: balancesByAccount('user:%:available'),
    alerts: {
      review_required: count('SELECT COUNT(*) AS total FROM payment_intents WHERE review_required=1'),
      unapplied: count("SELECT COUNT(*) AS total FROM payment_intents WHERE settlement='unapplied'"),
      failed_webhooks: count("SELECT COUNT(*) AS total FROM payment_webhook_events WHERE status='failed'"),
      failed_refunds: count("SELECT COUNT(*) AS total FROM refunds WHERE status='failed'"),
      pending_refunds: count("SELECT COUNT(*) AS total FROM refunds WHERE status IN ('pending','processing')"),
    },
    recent_failed_webhooks: all(`SELECT id,provider,event_type,event_status,reference,provider_reference,intent_id,error,attempts,received_at
      FROM payment_webhook_events WHERE status='failed' ORDER BY received_at DESC LIMIT 10`),
    live_problems: liveReadiness(),
  });
});

router.get('/providers', (req, res) => {
  requireAdmin(req);
  res.json({
    mode: paymentMode(),
    providers: listProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      countries: provider.countries,
      currencies: provider.currencies,
      methods: provider.methods,
      capabilities: provider.capabilities,
      docs_url: provider.docsUrl,
      fields: provider.fields,
      webhook_url: webhookUrl(provider.id),
      environments: {
        sandbox: describeProviderConfig(provider.id, 'sandbox'),
        live: { ...describeProviderConfig(provider.id, 'live'), available: provider.id !== 'simulator' },
      },
    })),
  });
});

const providerInput = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string().max(80), z.string().max(500)).default({}),
  secrets: z.record(z.string().max(80), z.string().max(4000).nullable()).default({}),
}).strict();

router.put('/providers/:id/:environment', (req, res) => {
  const admin = requireAdmin(req);
  const providerId = resourceId.parse(param(req));
  const env = environment.parse(param(req, 'environment'));
  const input = providerInput.parse(req.body);
  const provider = transaction(() => {
    const described = saveProviderConfig(providerId, env, input, admin.id);
    audit(admin.id, 'payments.provider.updated', 'payment_provider', `${providerId}:${env}`, JSON.stringify({
      enabled: input.enabled, settings: Object.keys(input.settings), secrets_changed: Object.keys(input.secrets),
    }));
    return described;
  });
  const warnings = env === paymentMode() && env === 'live' && liveReadiness().length ? ['Plus aucun prestataire réel valide : les paiements réels sont indisponibles.'] : [];
  res.json({ provider, warnings });
});

const modeInput = z.object({ mode: z.enum(['demo', 'sandbox', 'live']), confirmation: z.string().max(100).optional() }).strict();

router.put('/mode', (req, res) => {
  const admin = requireAdmin(req);
  const input = modeInput.parse(req.body);
  const previous = paymentMode();
  if (input.mode === 'live' && previous !== 'live') {
    if ((input.confirmation ?? '').normalize('NFC').trim() !== LIVE_CONFIRMATION) {
      throw new HttpError(400, `Saisissez exactement « ${LIVE_CONFIRMATION} » pour confirmer le passage aux paiements réels.`);
    }
    const problems = liveReadiness();
    if (problems.length) throw new HttpError(409, `Le mode réel ne peut pas être activé : ${problems.join(' ')}`);
  }
  const warnings: string[] = [];
  if (previous !== 'demo' && input.mode !== previous) {
    const held = escrowHeld(previous);
    if (held.length) warnings.push(`Des fonds restent en séquestre en mode ${previous} : ils restent gérés (versements, remboursements) mais aucun nouveau paiement ${previous} ne sera accepté.`);
    const open = one<{ total: number }>("SELECT COUNT(*) AS total FROM payment_intents WHERE mode=? AND status IN ('created','pending')", previous)!.total;
    if (open) warnings.push(`${open} paiement(s) ${previous} en attente : leurs webhooks seront refusés tant que ce mode n’est pas réactivé (la réconciliation continue).`);
  }
  transaction(() => {
    setSetting(PAYMENT_MODE_SETTING, input.mode, admin.id);
    audit(admin.id, 'payments.mode.changed', 'platform_setting', PAYMENT_MODE_SETTING, JSON.stringify({ from: previous, to: input.mode, warnings }));
  });
  res.json({ mode: input.mode, previous, warnings });
});

router.get('/settings', (req, res) => {
  requireAdmin(req);
  res.json({
    base_currency: baseCurrency(),
    base_currency_locked: !!one('SELECT id FROM ledger_entries LIMIT 1'),
    fx: fxRates(),
    fees: feeSettings(),
    currencies: Object.keys(currencyExponent),
  });
});

const settingsInput = z.object({
  base_currency: currencyCode.optional(),
  fx: z.record(currencyCode, z.number().positive().max(1e7)).optional(),
  fees: feesSchema.optional(),
}).strict();

router.put('/settings', (req, res) => {
  const admin = requireAdmin(req);
  const input = settingsInput.parse(req.body);
  transaction(() => {
    if (input.base_currency && input.base_currency !== baseCurrency()) {
      if (one('SELECT id FROM ledger_entries LIMIT 1') || one("SELECT id FROM payment_intents WHERE status IN ('created','pending') LIMIT 1")) {
        throw new HttpError(409, 'La devise de référence ne peut plus changer : le grand livre contient déjà des écritures.');
      }
      setSetting(BASE_CURRENCY_SETTING, input.base_currency, admin.id);
    }
    if (input.fx) setSetting(FX_SETTING, input.fx, admin.id);
    if (input.fees) setSetting(FEES_SETTING, input.fees, admin.id);
    audit(admin.id, 'payments.settings.updated', 'platform_setting', 'payments', JSON.stringify(input));
  });
  res.json({ base_currency: baseCurrency(), fx: fxRates(), fees: feeSettings() });
});

const intentFilters = z.object({
  status: z.enum(['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired']).optional(),
  mode: environment.optional(),
  provider: z.string().max(40).optional(),
  purpose: z.enum(['campaign_funding', 'order_purchase']).optional(),
  review: z.enum(['1']).optional(),
  q: z.string().trim().max(200).optional(),
  ...page,
});

router.get('/intents', (req, res) => {
  requireAdmin(req);
  const filters = intentFilters.parse(req.query);
  const like = filters.q ? `%${filters.q.replace(/[%_\\]/g, (char) => `\\${char}`)}%` : null;
  const where = `WHERE (? IS NULL OR i.status=?) AND (? IS NULL OR i.mode=?) AND (? IS NULL OR i.provider=?) AND (? IS NULL OR i.purpose=?)
    AND (? IS NULL OR i.review_required=1 OR i.settlement='unapplied')
    AND (? IS NULL OR i.id LIKE ? ESCAPE '\\' OR i.provider_reference LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR i.ref_id LIKE ? ESCAPE '\\')`;
  const params = [filters.status ?? null, filters.status ?? null, filters.mode ?? null, filters.mode ?? null, filters.provider ?? null, filters.provider ?? null,
    filters.purpose ?? null, filters.purpose ?? null, filters.review ?? null, like, like, like, like, like];
  const rows = all<IntentRow>(`SELECT i.* FROM payment_intents i JOIN users u ON u.id=i.user_id ${where} ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?`,
    ...params, filters.limit, filters.offset);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM payment_intents i JOIN users u ON u.id=i.user_id ${where}`, ...params)!.total;
  res.json({ intents: rows.map(adminIntent), total, limit: filters.limit, offset: filters.offset });
});

router.get('/intents/:id', (req, res) => {
  requireAdmin(req);
  const intent = getIntent(resourceId.parse(param(req)));
  if (!intent) throw new HttpError(404, 'Paiement introuvable.');
  res.json({
    intent: adminIntent(intent),
    refunds: all<RefundRow>('SELECT * FROM refunds WHERE intent_id=? ORDER BY created_at', intent.id),
    webhooks: all('SELECT id,provider,event_key,event_type,event_status,status,error,attempts,received_at,processed_at FROM payment_webhook_events WHERE intent_id=? ORDER BY received_at', intent.id),
    journals: all('SELECT id,kind,mode,currency,ref_type,ref_id,memo,created_at FROM ledger_journals WHERE (ref_type=\'payment_intent\' AND ref_id=?) OR id=? ORDER BY created_at', intent.id, intent.settled_journal_id ?? ''),
  });
});

router.post('/intents/:id/reconcile', async (req, res) => {
  const admin = requireAdmin(req);
  const intent = getIntent(resourceId.parse(param(req)));
  if (!intent) throw new HttpError(404, 'Paiement introuvable.');
  const updated = intent.status === 'created' || intent.status === 'pending'
    ? await reconcileIntent(intent, 'admin')
    : await refreshIntent(intent.id, 'admin');
  transaction(() => audit(admin.id, 'payments.intent.reconciled', 'payment_intent', intent.id, `${intent.status} -> ${updated.status}`));
  res.json({ intent: adminIntent(getIntent(intent.id)!) });
});

const webhookFilters = z.object({
  status: z.enum(['received', 'processed', 'ignored', 'failed']).optional(),
  provider: z.string().max(40).optional(),
  ...page,
});

router.get('/webhooks', (req, res) => {
  requireAdmin(req);
  const filters = webhookFilters.parse(req.query);
  const where = 'WHERE (? IS NULL OR status=?) AND (? IS NULL OR provider=?)';
  const params = [filters.status ?? null, filters.status ?? null, filters.provider ?? null, filters.provider ?? null];
  res.json({
    events: all(`SELECT id,provider,event_key,mode,event_type,event_status,reference,provider_reference,intent_id,status,error,attempts,received_at,processed_at
      FROM payment_webhook_events ${where} ORDER BY received_at DESC,id DESC LIMIT ? OFFSET ?`, ...params, filters.limit, filters.offset),
    total: one<{ total: number }>(`SELECT COUNT(*) AS total FROM payment_webhook_events ${where}`, ...params)!.total,
    limit: filters.limit,
    offset: filters.offset,
  });
});

const refundFilters = z.object({ status: z.enum(['pending', 'processing', 'succeeded', 'failed']).optional(), ...page });

router.get('/refunds', (req, res) => {
  requireAdmin(req);
  const filters = refundFilters.parse(req.query);
  res.json({
    refunds: all<RefundRow>('SELECT * FROM refunds WHERE (? IS NULL OR status=?) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
      filters.status ?? null, filters.status ?? null, filters.limit, filters.offset),
    total: one<{ total: number }>('SELECT COUNT(*) AS total FROM refunds WHERE (? IS NULL OR status=?)', filters.status ?? null, filters.status ?? null)!.total,
  });
});

router.post('/refunds/:id/retry', async (req, res) => {
  const admin = requireAdmin(req);
  const refundId = resourceId.parse(param(req));
  if (!getRefund(refundId)) throw new HttpError(404, 'Remboursement introuvable.');
  const result = await retryRefund(refundId);
  if (!result.changed) throw new HttpError(409, 'Ce remboursement est déjà en cours ou terminé.');
  transaction(() => audit(admin.id, 'payments.refund.retried', 'refund', refundId, result.refund?.status ?? ''));
  res.json({ refund: result.refund });
});

const journalFilters = z.object({ mode: environment.optional(), kind: z.string().max(40).optional(), ...page });

router.get('/journals', (req, res) => {
  requireAdmin(req);
  const filters = journalFilters.parse(req.query);
  const journals = all<{ id: string; kind: string; mode: string; currency: string; ref_type: string; ref_id: string; memo: string; created_by: string | null; created_at: string }>(
    `SELECT id,kind,mode,currency,ref_type,ref_id,memo,created_by,created_at FROM ledger_journals
     WHERE (? IS NULL OR mode=?) AND (? IS NULL OR kind=?) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
    filters.mode ?? null, filters.mode ?? null, filters.kind ?? null, filters.kind ?? null, filters.limit, filters.offset);
  res.json({
    journals: journals.map((journal) => ({
      ...journal,
      entries: all('SELECT account,amount_minor FROM ledger_entries WHERE journal_id=? ORDER BY amount_minor', journal.id),
    })),
    ledger_balanced: ledgerIsBalanced(),
  });
});

const ledgerAccount = z.string().max(120).regex(
  /^(user:[A-Za-z0-9_-]+:(available|pending)|escrow:(campaign|order):[A-Za-z0-9_-]+|provider:[a-z_]+|platform:(fees|taxes|adjustments)|withdrawals:in_flight)$/,
  'Compte du grand livre invalide.');
const adjustmentInput = z.object({
  mode: environment,
  currency: currencyCode.optional(),
  memo: z.string().trim().min(5).max(500),
  legs: z.array(z.object({ account: ledgerAccount, amount_minor: z.number().int().refine((value) => value !== 0 && Number.isSafeInteger(value)) }).strict()).min(2).max(10),
}).strict();

router.post('/adjustments', (req, res) => {
  const admin = requireAdmin(req);
  const input = adjustmentInput.parse(req.body);
  if (input.legs.reduce((sum, leg) => sum + leg.amount_minor, 0) !== 0) throw new HttpError(400, 'Écriture non équilibrée : la somme des montants doit être nulle.');
  const refId = id();
  const journal = transaction(() => {
    const posted = postJournal({
      idempotencyKey: `adjustment:${refId}`, kind: 'adjustment', mode: input.mode, currency: input.currency ?? baseCurrency(),
      refType: 'admin', refId, memo: input.memo, actorId: admin.id,
      legs: input.legs.map((leg) => ({ account: leg.account, amountMinor: leg.amount_minor })),
    });
    audit(admin.id, 'payments.ledger.adjustment', 'ledger_adjustment', refId, JSON.stringify({ journal_id: posted.journalId, ...input }));
    return posted;
  });
  res.status(201).json({ journal_id: journal.journalId, ref_id: refId, ledger_balanced: ledgerIsBalanced() });
});

export default router;
