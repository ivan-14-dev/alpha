import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { canReadProject, HttpError, param, requireUser } from '../core.js';
import { all, one } from '../db.js';
import { campaignBalance, fundCampaign, payMission, paymentSummary } from '../finance.js';
import { requireCapability } from '../platform/guards.js';
import adminRouter from '../payments/admin.js';
import { availableProviders, completeSimulated } from '../payments/checkout.js';
import { campaignBudget, campaignMoneyRow, hasDemoFunds } from '../payments/core/budget.js';
import { feeSettings } from '../payments/core/fees.js';
import '../payments/core/privacy.js';
import '../payments/core/reconcile.js';
import { publicIntent, type IntentRow } from '../payments/core/store.js';
import { payMissionFromEscrow, refundCampaignEscrow } from '../payments/escrow.js';
import { cancelIntent, createIntent, readableIntent, refreshIntent } from '../payments/intents.js';
import { ledgerAccounts } from '../payments/ledger.js';
import { baseCurrency, paymentMode } from '../payments/mode.js';
import { receiveWebhook } from '../payments/webhooks.js';

const router = Router();
router.use('/admin', adminRouter);
const notice = 'Mode démonstration : aucun argent réel n’est débité ou versé. Aucun retrait réel n’est disponible.';
const resourceId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
const funding = z.object({
  amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

interface CampaignRow {
  id: string;
  title: string;
  project_id: string;
  reward_cents: number;
  slots: number;
  status: 'open' | 'closed';
  payment_mode: 'demo' | 'sandbox' | 'live';
  created_at: string;
}

interface TransactionRow {
  id: string;
  campaign_id: string | null;
  mission_id: string | null;
  order_id: string | null;
  kind: 'funding' | 'payout' | 'purchase' | 'sale' | 'refund';
  amount_cents: number;
  status: 'completed' | 'pending' | 'failed';
  mode: 'demo';
  created_at: string;
  campaign_title: string | null;
  campaign_project_id: string | null;
  campaign_owner_id: string | null;
  listing_title: string | null;
}

router.get('/summary', (req, res) => {
  const user = requireUser(req);
  const campaigns = all<{ id: string }>('SELECT id FROM campaigns WHERE owner_id=?', user.id);
  const reserved = campaigns.reduce((total, campaign) => total + campaignBalance(campaign.id).reserved_cents, 0);
  const accepted = one<{ payable_cents: number; payable_count: number }>(
    `SELECT COALESCE(SUM(c.reward_cents),0) AS payable_cents, COUNT(*) AS payable_count
     FROM missions m JOIN campaigns c ON c.id=m.campaign_id
     WHERE c.owner_id=? AND m.status='accepted'`, user.id,
  )!;
  res.json({
    summary: { ...paymentSummary(user.id), reserved_cents: reserved, ...accepted },
    mode: 'demo',
    notice,
  });
});

router.get('/transactions', (req, res) => {
  const user = requireUser(req);
  const { limit, offset } = pagination.parse(req.query);
  const rows = all<TransactionRow>(
    `SELECT t.id,t.campaign_id,t.mission_id,t.order_id,t.kind,t.amount_cents,t.status,t.mode,t.created_at,
      c.title AS campaign_title,c.project_id AS campaign_project_id,c.owner_id AS campaign_owner_id,
      l.title AS listing_title
     FROM transactions t
     LEFT JOIN campaigns c ON c.id=t.campaign_id
     LEFT JOIN orders o ON o.id=t.order_id AND (o.buyer_id=? OR o.seller_id=?)
     LEFT JOIN listings l ON l.id=o.listing_id
     WHERE t.user_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`,
    user.id, user.id, user.id, limit, offset,
  );
  const transactions = rows.map(({ campaign_project_id, campaign_owner_id, campaign_title, ...entry }) => {
    const visibleTitle = campaign_project_id && (campaign_owner_id === user.id || canReadProject(user.id, campaign_project_id))
      ? campaign_title
      : null;
    return {
      ...entry,
      campaign_title: visibleTitle,
      title: visibleTitle ?? entry.listing_title ?? (entry.campaign_id ? 'Campagne privée' : 'Opération de démonstration'),
    };
  });
  const total = one<{ total: number }>('SELECT COUNT(*) AS total FROM transactions WHERE user_id=?', user.id)!.total;
  res.json({ transactions, total, limit, offset, mode: 'demo', notice });
});

router.get('/campaigns', (req, res) => {
  const user = requireUser(req);
  const { limit, offset } = pagination.parse(req.query);
  const campaignId = resourceId.optional().parse(req.query.campaign) ?? null;
  const rows = all<CampaignRow>(
    `SELECT id,title,project_id,reward_cents,slots,status,payment_mode,created_at FROM campaigns
     WHERE owner_id=? AND (? IS NULL OR id=?) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
    user.id, campaignId, campaignId, limit, offset,
  );
  const campaigns = rows.map((campaign) => {
    const balance = campaignBudget(campaign.id);
    const budget = campaign.slots * campaign.reward_cents;
    const net = balance.funded_cents - ('refunded_cents' in balance ? Number(balance.refunded_cents) : 0);
    return { ...campaign, ...balance, budget_cents: budget, remaining_cents: Math.max(0, budget - net) };
  });
  const total = one<{ total: number }>(
    'SELECT COUNT(*) AS total FROM campaigns WHERE owner_id=? AND (? IS NULL OR id=?)',
    user.id, campaignId, campaignId,
  )!.total;
  res.json({ campaigns, total, limit, offset, mode: 'demo', notice });
});

router.get('/missions', (req, res) => {
  const user = requireUser(req);
  const { limit, offset } = pagination.parse(req.query);
  const missions = all<{
    id: string; campaign_id: string; status: 'accepted'; updated_at: string;
    campaign_title: string; reward_cents: number; tester_name: string; tester_avatar_color: string;
  }>(
    `SELECT m.id,m.campaign_id,m.status,m.updated_at,c.title AS campaign_title,c.reward_cents,
      u.name AS tester_name,u.avatar_color AS tester_avatar_color
     FROM missions m JOIN campaigns c ON c.id=m.campaign_id JOIN users u ON u.id=m.tester_id
     WHERE c.owner_id=? AND m.status='accepted'
     ORDER BY m.updated_at DESC,m.id DESC LIMIT ? OFFSET ?`, user.id, limit, offset,
  );
  const total = one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM missions m JOIN campaigns c ON c.id=m.campaign_id
     WHERE c.owner_id=? AND m.status='accepted'`, user.id,
  )!.total;
  res.json({ missions, total, limit, offset, mode: 'demo', notice });
});

router.post('/campaigns/:id/fund', (req, res) => {
  const user = requireUser(req);
  const campaignId = resourceId.parse(param(req));
  const { amount_cents } = funding.parse(req.body);
  const campaign = campaignMoneyRow(campaignId);
  // Real-money campaigns (or any new campaign once real payments are on) are funded through a checkout intent.
  if (campaign && campaign.owner_id === user.id
    && (campaign.payment_mode !== 'demo' || (paymentMode() !== 'demo' && !hasDemoFunds(campaign.id)))) {
    throw new HttpError(409, 'Cette campagne se finance par paiement sécurisé : utilisez « Financer » depuis la page de la campagne.');
  }
  const balance = fundCampaign(campaignId, user.id, amount_cents);
  res.json({ balance, mode: 'demo', notice });
});

router.post('/missions/:id/pay', (req, res) => {
  const user = requireUser(req);
  const missionId = resourceId.parse(param(req));
  const mission = one<{ payment_mode: string }>('SELECT c.payment_mode FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?', missionId);
  if (mission && mission.payment_mode !== 'demo') {
    res.json(payMissionFromEscrow(missionId, user.id));
    return;
  }
  res.json({ ...payMission(missionId, user.id), notice });
});

/* ----------------------------- V4: real payments (sandbox / live) ----------------------------- */

router.get('/config', (_req, res) => {
  const mode = paymentMode();
  res.json({ mode, base_currency: baseCurrency(), fees: feeSettings() });
});

router.get('/providers/available', (req, res) => {
  requireUser(req);
  const query = z.object({
    purpose: z.enum(['campaign_funding', 'order_purchase']).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  }).parse(req.query);
  res.json(availableProviders(query.currency));
});

const intentInput = z.object({
  purpose: z.enum(['campaign_funding', 'order_purchase']),
  ref_id: resourceId,
  provider: z.string().min(2).max(40).regex(/^[a-z_]+$/),
  method: z.enum(['card', 'mobile_money', 'bank_transfer']).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ]{6,20}$/, 'Numéro de téléphone invalide.').transform((value) => value.replace(/\s+/g, '')).optional(),
  operator: z.string().trim().min(2).max(20).regex(/^[a-z_]+$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  amount_base_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  idempotency_key: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

router.post('/intents', async (req, res) => {
  const user = requireCapability(req, 'money');
  const input = intentInput.parse(req.body);
  const result = await createIntent(user, input);
  res.status(result.reused ? 200 : 201).json(result);
});

router.get('/intents', (req, res) => {
  const user = requireUser(req);
  const { limit, offset } = pagination.parse({ limit: req.query.limit, offset: req.query.offset });
  const filters = z.object({
    purpose: z.enum(['campaign_funding', 'order_purchase']).optional(),
    ref_id: resourceId.optional(),
  }).parse({ purpose: req.query.purpose, ref_id: req.query.ref_id });
  const where = 'WHERE user_id=? AND (? IS NULL OR purpose=?) AND (? IS NULL OR ref_id=?)';
  const params = [user.id, filters.purpose ?? null, filters.purpose ?? null, filters.ref_id ?? null, filters.ref_id ?? null];
  const intents = all<IntentRow>(`SELECT * FROM payment_intents ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM payment_intents ${where}`, ...params)!.total;
  res.json({ intents: intents.map(publicIntent), total, limit, offset, mode: paymentMode() });
});

router.get('/intents/:id', (req, res) => {
  const user = requireUser(req);
  res.json({ intent: publicIntent(readableIntent(resourceId.parse(param(req)), user)) });
});

router.post('/intents/:id/refresh', async (req, res) => {
  const user = requireUser(req);
  const intent = readableIntent(resourceId.parse(param(req)), user);
  const updated = await refreshIntent(intent.id, user.role === 'admin' && intent.user_id !== user.id ? 'admin' : 'payer');
  res.json({ intent: publicIntent(updated) });
});

router.post('/intents/:id/cancel', (req, res) => {
  const user = requireUser(req);
  res.json({ intent: publicIntent(cancelIntent(resourceId.parse(param(req)), user.id)) });
});

router.post('/simulator/:intentId/complete', async (req, res) => {
  const user = requireCapability(req, 'money');
  const intentId = resourceId.parse(param(req, 'intentId'));
  const { outcome } = z.object({ outcome: z.enum(['succeeded', 'failed']) }).strict().parse(req.body);
  res.json(await completeSimulated(user, intentId, outcome));
});

/** Ledger balances of the member (real modes) next to the V3 demo summary. */
router.get('/balances', (req, res) => {
  const user = requireUser(req);
  const balances = all<{ mode: string; currency: string; available_minor: number }>(
    `SELECT mode,currency,COALESCE(SUM(amount_minor),0) AS available_minor FROM ledger_entries WHERE account=? GROUP BY mode,currency ORDER BY mode,currency`,
    ledgerAccounts.userAvailable(user.id));
  const escrow = all<{ mode: string; currency: string; amount_minor: number }>(
    `SELECT e.mode,e.currency,COALESCE(SUM(e.amount_minor),0) AS amount_minor FROM ledger_entries e
     JOIN campaigns c ON e.account='escrow:campaign:' || c.id WHERE c.owner_id=? GROUP BY e.mode,e.currency ORDER BY e.mode,e.currency`, user.id);
  res.json({ mode: paymentMode(), base_currency: baseCurrency(), balances, campaign_escrow: escrow.filter((row) => row.amount_minor !== 0) });
});

router.post('/campaigns/:id/refund', (req, res) => {
  const user = requireCapability(req, 'money');
  const campaignId = resourceId.parse(param(req));
  const { reason } = z.object({ reason: z.string().trim().max(500).default('') }).strict().parse(req.body ?? {});
  res.json({ refund: refundCampaignEscrow(campaignId, user.id, reason || 'Solde de campagne non utilisé'), balance: campaignBudget(campaignId) });
});

/** Provider webhooks: raw body (signature check), CSRF-exempt, GET accepted for providers that call back with query params. */
async function webhook(req: Request, res: Response) {
  const providerId = z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/).safeParse(req.params.provider);
  if (!providerId.success) {
    res.status(404).json({ error: 'Prestataire de paiement inconnu.' });
    return;
  }
  const result = await receiveWebhook(providerId.data, {
    method: req.method,
    headers: req.headers,
    rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    query: req.query as Record<string, unknown>,
  });
  res.status(result.status).json(result.body);
}
router.all('/webhooks/:provider', webhook);

export default router;
