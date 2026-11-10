import { all, one } from '../../db.js';
import { HttpError } from '../../core.js';
import { campaignBalance } from '../../finance.js';
import { ledgerAccounts } from '../ledger.js';
import { baseCurrency, type LedgerMode, type PaymentMode } from '../mode.js';

export interface CampaignMoneyRow {
  id: string;
  owner_id: string;
  title: string;
  status: string;
  deadline: string;
  reward_cents: number;
  slots: number;
  payment_mode: PaymentMode;
}

export function campaignMoneyRow(campaignId: string): CampaignMoneyRow | undefined {
  return one<CampaignMoneyRow>('SELECT id,owner_id,title,status,deadline,reward_cents,slots,payment_mode FROM campaigns WHERE id=?', campaignId);
}

export function hasDemoFunds(campaignId: string): boolean {
  return !!one("SELECT id FROM transactions WHERE campaign_id=? AND kind='funding' AND status='completed' LIMIT 1", campaignId);
}

/** Missions still holding a reward reservation (same rule as the V3 demo balance). */
export function reservedCents(campaignId: string): number {
  return one<{ total: number }>(`SELECT COALESCE(SUM(c.reward_cents),0) AS total FROM missions m JOIN campaigns c ON c.id=m.campaign_id
    WHERE m.campaign_id=? AND m.status NOT IN ('paid','cancelled')`, campaignId)!.total;
}

/** Ledger-based budget of a sandbox/live campaign, in base currency minor units. Same core shape as `campaignBalance`. */
export function ledgerCampaignBudget(campaignId: string, mode: LedgerMode) {
  const currency = baseCurrency();
  const totals = all<{ kind: string; total: number }>(`SELECT j.kind, COALESCE(SUM(e.amount_minor),0) AS total
    FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id
    WHERE e.account=? AND e.mode=? AND e.currency=? GROUP BY j.kind`, ledgerAccounts.campaignEscrow(campaignId), mode, currency);
  const byKind = (kind: string) => totals.find((row) => row.kind === kind)?.total ?? 0;
  const escrow = totals.reduce((sum, row) => sum + row.total, 0);
  const reserved = reservedCents(campaignId);
  return {
    funded_cents: byKind('campaign.funded'),
    paid_cents: -byKind('mission.paid'),
    reserved_cents: reserved,
    available_cents: escrow - reserved,
    refunded_cents: -byKind('campaign.refunded'),
    escrow_cents: escrow,
    mode,
    currency,
  };
}

/** Demo campaigns keep the exact V3 balance object; sandbox/live campaigns read the ledger. */
export function campaignBudget(campaignId: string) {
  const campaign = campaignMoneyRow(campaignId);
  if (!campaign) throw new HttpError(404, 'Campagne introuvable.');
  return campaign.payment_mode === 'demo' ? campaignBalance(campaignId) : ledgerCampaignBudget(campaignId, campaign.payment_mode);
}

/** Amount still to collect so that every slot is covered (net of refunds). */
export function remainingToFund(campaign: CampaignMoneyRow, mode: LedgerMode): number {
  const budget = ledgerCampaignBudget(campaign.id, mode);
  return Math.max(0, campaign.slots * campaign.reward_cents - (budget.funded_cents - budget.refunded_cents));
}
