import { all, one, run, transaction } from './db.js';
import { audit, HttpError, id, notify, now } from './core.js';

export function campaignBalance(campaignId: string) {
  const funded = one<{ total: number }>("SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE campaign_id = ? AND kind = 'funding' AND status = 'completed'", campaignId)!.total;
  const paid = one<{ total: number }>("SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE campaign_id = ? AND kind = 'payout' AND status = 'completed'", campaignId)!.total;
  const reserved = one<{ total: number }>(`SELECT COALESCE(SUM(c.reward_cents),0) AS total FROM missions m JOIN campaigns c ON c.id=m.campaign_id
    WHERE m.campaign_id=? AND m.status NOT IN ('paid','cancelled')`, campaignId)!.total;
  return { funded_cents: funded, paid_cents: paid, reserved_cents: reserved, available_cents: funded - paid - reserved };
}

export function fundCampaign(campaignId: string, userId: string, amount: number) {
  return transaction(() => {
    const campaign = one<{ owner_id: string; slots: number; reward_cents: number; status: string }>('SELECT * FROM campaigns WHERE id=?', campaignId);
    if (!campaign) throw new HttpError(404, 'Campagne introuvable.');
    if (campaign.owner_id !== userId) throw new HttpError(403, 'Seul le responsable peut financer cette campagne.');
    if (campaign.status !== 'open') throw new HttpError(409, 'Cette campagne est fermee.');
    const balance = campaignBalance(campaignId);
    const remaining = campaign.slots * campaign.reward_cents - balance.funded_cents;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) throw new HttpError(400, 'Montant superieur au budget restant ou invalide.');
    run("INSERT INTO transactions (id,user_id,campaign_id,kind,amount_cents) VALUES (?,?,?,'funding',?)", id(), userId, campaignId, amount);
    audit(userId, 'demo.campaign.funded', 'campaign', campaignId, String(amount));
    return campaignBalance(campaignId);
  });
}

export function payMission(missionId: string, userId: string) {
  return transaction(() => {
    const mission = one<{ status: string; tester_id: string; campaign_id: string; owner_id: string; reward_cents: number }>(
      'SELECT m.*,c.owner_id,c.reward_cents FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?', missionId);
    if (!mission) throw new HttpError(404, 'Mission introuvable.');
    if (mission.owner_id !== userId) throw new HttpError(403, 'Seul le responsable peut declencher le versement.');
    if (mission.status === 'paid') return { status: 'paid', mode: 'demo' };
    if (mission.status !== 'accepted') throw new HttpError(409, 'Le rapport doit etre accepte avant le versement.');
    const balance = campaignBalance(mission.campaign_id);
    if (balance.funded_cents - balance.paid_cents < mission.reward_cents) throw new HttpError(409, 'Budget insuffisant.');
    run("INSERT INTO transactions (id,user_id,campaign_id,mission_id,kind,amount_cents) VALUES (?,?,?,?,'payout',?)",
      id(), mission.tester_id, mission.campaign_id, missionId, mission.reward_cents);
    run("UPDATE missions SET status='paid', updated_at=? WHERE id=?", now(), missionId);
    notify(mission.tester_id, 'payment', 'Versement de demonstration confirme', 'Aucun argent reel ne sera transfere.', '/payments');
    audit(userId, 'demo.mission.paid', 'mission', missionId);
    return { status: 'paid', mode: 'demo' };
  });
}

export function paymentSummary(userId: string) {
  const transactions = all<{ kind: string; amount_cents: number }>('SELECT kind,amount_cents FROM transactions WHERE user_id=? AND status=?', userId, 'completed');
  return {
    earned_cents: transactions.filter((t) => t.kind === 'payout' || t.kind === 'sale').reduce((n, t) => n + t.amount_cents, 0),
    spent_cents: transactions.filter((t) => t.kind === 'funding' || t.kind === 'purchase').reduce((n, t) => n + t.amount_cents, 0),
    mode: 'demo',
  };
}
