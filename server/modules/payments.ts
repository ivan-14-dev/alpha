import { Router } from 'express';
import { z } from 'zod';
import { canReadProject, param, requireUser } from '../core.js';
import { all, one } from '../db.js';
import { campaignBalance, fundCampaign, payMission, paymentSummary } from '../finance.js';

const router = Router();
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
    `SELECT id,title,project_id,reward_cents,slots,status,created_at FROM campaigns
     WHERE owner_id=? AND (? IS NULL OR id=?) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
    user.id, campaignId, campaignId, limit, offset,
  );
  const campaigns = rows.map((campaign) => {
    const balance = campaignBalance(campaign.id);
    const budget = campaign.slots * campaign.reward_cents;
    return { ...campaign, ...balance, budget_cents: budget, remaining_cents: Math.max(0, budget - balance.funded_cents) };
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
  const balance = fundCampaign(campaignId, user.id, amount_cents);
  res.json({ balance, mode: 'demo', notice });
});

router.post('/missions/:id/pay', (req, res) => {
  const user = requireUser(req);
  const missionId = resourceId.parse(param(req));
  res.json({ ...payMission(missionId, user.id), notice });
});

export default router;
