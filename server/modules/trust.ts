import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, canReadProject, HttpError, id, isPublicPost, notify, now, param, requireAdmin, requireUser } from '../core.js';
import { appendOrderEvent } from './marketplace.js';

const router = Router();
const targetTypes = ['project', 'post', 'listing', 'mission', 'order', 'user'] as const;
type TargetType = typeof targetTypes[number];
type Report = {
  id: string; reporter_id: string; target_type: TargetType; target_id: string;
  reason: string; status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  decision: string; created_at: string;
};
type Mission = { id: string; status: string; tester_id: string; owner_id: string; title: string };
type Order = { id: string; status: string; buyer_id: string; seller_id: string; title: string; delivery_text: string; version: number; revision_requested: number };
type WorkReport = { summary: string; steps: string; expected: string; observed: string; evidence_url: string };
const identifier = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const reportInput = z.object({
  target_type: z.enum(targetTypes),
  target_id: identifier,
  reason: z.string().trim().min(10).max(2000),
}).strict();
const decisionInput = z.object({
  status: z.enum(['reviewing', 'resolved', 'dismissed']),
  decision: z.string().trim().min(10).max(4000),
  resolution: z.enum(['in_progress', 'changes_requested', 'submitted', 'accepted', 'cancelled', 'paid', 'delivered']).optional(),
  revision_note: z.string().trim().min(10).max(2000).optional(),
}).strict();

function missionFor(targetId: string) {
  return one<Mission>(`SELECT m.id,m.status,m.tester_id,c.owner_id,c.title FROM missions m
    JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?`, targetId);
}

function orderFor(targetId: string) {
  return one<Order>(`SELECT o.id,o.status,o.buyer_id,o.seller_id,o.delivery_text,o.version,o.revision_requested,l.title FROM orders o
    JOIN listings l ON l.id=o.listing_id WHERE o.id=?`, targetId);
}

function hasPayout(missionId: string) {
  return !!one("SELECT id FROM transactions WHERE mission_id=? AND kind='payout' AND status IN ('completed','pending')", missionId);
}

function hasOrderSettlement(orderId: string) {
  return !!one("SELECT id FROM transactions WHERE order_id=? AND kind IN ('sale','refund') AND status IN ('completed','pending')", orderId);
}

function verifyTarget(type: TargetType, targetId: string, userId: string) {
  let accessible = false;
  switch (type) {
    case 'mission': {
      const mission = missionFor(targetId);
      accessible = !!mission && (mission.owner_id === userId || mission.tester_id === userId);
      break;
    }
    case 'order': {
      const order = orderFor(targetId);
      accessible = !!order && (order.buyer_id === userId || order.seller_id === userId);
      break;
    }
    case 'project':
      accessible = canReadProject(userId, targetId);
      break;
    case 'post':
      accessible = isPublicPost(targetId);
      break;
    case 'listing':
      accessible = !!one("SELECT id FROM listings WHERE id=? AND (status='active' OR seller_id=?)", targetId, userId);
      break;
    case 'user':
      accessible = !!one('SELECT id FROM users WHERE id=?', targetId);
      break;
  }
  if (!accessible) throw new HttpError(404, 'Élément introuvable ou inaccessible. Vous devez participer à la mission ou à la commande.');
}

function openReports(type: TargetType, targetId: string) {
  return one<{ count: number }>("SELECT COUNT(*) AS count FROM moderation_reports WHERE target_type=? AND target_id=? AND status IN ('open','reviewing')", type, targetId)!.count;
}

function notifyParticipants(type: 'mission' | 'order', targetId: string, body: string) {
  const mission = type === 'mission' ? missionFor(targetId) : undefined;
  const order = type === 'order' ? orderFor(targetId) : undefined;
  const participants = mission ? [mission.owner_id, mission.tester_id] : order ? [order.buyer_id, order.seller_id] : [];
  for (const userId of new Set(participants)) {
    notify(userId, 'moderation', type === 'mission' ? 'Suivi de votre mission' : 'Suivi de votre commande', body, type === 'mission' ? '/missions' : '/marketplace');
  }
}

function disputeTarget(type: TargetType, targetId: string, actorId: string) {
  if (type === 'mission') {
    const mission = missionFor(targetId)!;
    if (['assigned', 'in_progress', 'submitted', 'changes_requested', 'accepted'].includes(mission.status) && !hasPayout(targetId)) {
      run("UPDATE missions SET status='disputed',updated_at=? WHERE id=?", now(), targetId);
      notifyParticipants(type, targetId, 'Cette mission est suspendue pour examen par la modération. Aucun paiement ne peut être déclenché pendant le litige.');
      return mission.status;
    }
  }
  if (type === 'order') {
    const order = orderFor(targetId)!;
    if (['paid', 'delivered'].includes(order.status) && !hasOrderSettlement(targetId)) {
      run("UPDATE orders SET status='disputed',version=version+1 WHERE id=?", targetId);
      appendOrderEvent(targetId, actorId, 'disputed');
      notifyParticipants(type, targetId, 'Cette commande est suspendue pour examen par la modération. Aucun remboursement n’est effectué automatiquement.');
      return order.status;
    }
  }
  return null;
}

function contextFor(report: Report) {
  switch (report.target_type) {
    case 'mission': {
      const mission = missionFor(report.target_id);
      return mission ? {
        title: mission.title, status: mission.status,
        work_report: one<WorkReport>('SELECT summary,steps,expected,observed,evidence_url FROM test_reports WHERE mission_id=?', report.target_id) ?? null,
        payout_recorded: hasPayout(report.target_id),
      } : null;
    }
    case 'order': {
      const order = orderFor(report.target_id);
      return order ? {
        title: order.title, status: order.status, delivery_text: order.delivery_text,
        version: order.version, revision_requested: order.revision_requested,
        settlement_recorded: hasOrderSettlement(report.target_id),
      } : null;
    }
    case 'project':
      return one('SELECT title,summary AS body,visibility AS status FROM projects WHERE id=?', report.target_id) ?? null;
    case 'post':
      return one('SELECT body FROM posts WHERE id=?', report.target_id) ?? null;
    case 'listing':
      return one('SELECT title,description AS body,status FROM listings WHERE id=?', report.target_id) ?? null;
    case 'user':
      return one('SELECT name AS title,bio AS body FROM users WHERE id=?', report.target_id) ?? null;
  }
}

router.get('/reports', (req, res) => {
  const user = requireUser(req);
  if (user.role === 'admin') {
    const reports = all<Report & { reporter_name: string }>(`SELECT r.*,u.name AS reporter_name FROM moderation_reports r
      JOIN users u ON u.id=r.reporter_id
      ORDER BY CASE WHEN r.status IN ('open','reviewing') THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC LIMIT 100`);
    res.json({ reports: reports.map((report) => ({
      ...report, context: contextFor(report), open_reports: openReports(report.target_type, report.target_id),
    })) });
    return;
  }
  res.json({ reports: all<Report>('SELECT * FROM moderation_reports WHERE reporter_id=? ORDER BY created_at DESC,id DESC LIMIT 100', user.id) });
});

router.post('/reports', (req, res) => {
  const user = requireUser(req);
  const input = reportInput.parse(req.body);
  const report = transaction(() => {
    verifyTarget(input.target_type, input.target_id, user.id);
    if (one(`SELECT id FROM moderation_reports WHERE reporter_id=? AND target_type=? AND target_id=?
      AND status IN ('open','reviewing')`, user.id, input.target_type, input.target_id)) {
      throw new HttpError(409, 'Vous avez déjà un signalement ouvert pour cet élément.');
    }
    const reportId = id();
    run('INSERT INTO moderation_reports (id,reporter_id,target_type,target_id,reason) VALUES (?,?,?,?,?)',
      reportId, user.id, input.target_type, input.target_id, input.reason);
    const previousState = disputeTarget(input.target_type, input.target_id, user.id);
    audit(user.id, 'moderation.report.created', 'report', reportId, JSON.stringify({
      target_type: input.target_type, target_id: input.target_id, previous_state: previousState,
    }));
    notify(user.id, 'moderation', 'Signalement enregistré', 'Votre dossier est visible uniquement par vous et la modération.', '/trust');
    for (const admin of all<{ id: string }>("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 100")) {
      if (admin.id !== user.id) notify(admin.id, 'moderation', 'Nouveau dossier à examiner', 'Un signalement attend votre examen.', '/trust');
    }
    return one<Report>('SELECT * FROM moderation_reports WHERE id=?', reportId)!;
  });
  res.status(201).json({ report });
});

router.get('/audit', (req, res) => {
  requireAdmin(req);
  const events = all(`SELECT a.id,a.actor_id,u.name AS actor_name,a.action,a.target_type,a.target_id,a.detail,a.created_at
    FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id DESC LIMIT 100`);
  res.json({ events });
});

router.post('/reports/:id/resolve', (req, res) => {
  const admin = requireAdmin(req);
  const reportId = identifier.parse(param(req));
  const input = decisionInput.parse(req.body);
  const report = transaction(() => {
    const current = one<Report>('SELECT * FROM moderation_reports WHERE id=?', reportId);
    if (!current) throw new HttpError(404, 'Signalement introuvable.');
    if (!['open', 'reviewing'].includes(current.status)) throw new HttpError(409, 'Ce dossier est déjà clôturé.');

    const mission = current.target_type === 'mission' ? missionFor(current.target_id) : undefined;
    const order = current.target_type === 'order' ? orderFor(current.target_id) : undefined;
    const targetStatus = mission?.status ?? order?.status;
    const remaining = openReports(current.target_type, current.target_id) - 1;
    const closing = input.status !== 'reviewing';
    const mustResume = closing && targetStatus === 'disputed' && remaining === 0;

    if (input.resolution && !mustResume) {
      throw new HttpError(409, remaining > 0 && closing && targetStatus === 'disputed'
        ? 'Clôturez les autres dossiers actifs de cet élément avant de choisir sa reprise.'
        : 'Une reprise concerne uniquement la clôture du dernier dossier d’un élément en litige.');
    }
    if (mustResume && !input.resolution) {
      throw new HttpError(400, 'Choisissez explicitement l’état de reprise pour ne pas laisser ce litige bloqué.');
    }
    if (input.revision_note && (!mustResume || !mission || input.resolution !== 'changes_requested')) {
      throw new HttpError(400, 'La consigne de révision concerne uniquement une mission reprise avec des modifications demandées.');
    }
    if (mustResume && mission) {
      if (!['in_progress', 'changes_requested', 'submitted', 'accepted', 'cancelled'].includes(input.resolution!)) {
        throw new HttpError(400, 'Reprise de mission invalide.');
      }
      if (hasPayout(mission.id)) {
        throw new HttpError(409, 'Un versement existe déjà. Une correction financière est nécessaire et sort du périmètre de cette démonstration.');
      }
      const workReport = one('SELECT id FROM test_reports WHERE mission_id=?', mission.id);
      if (['changes_requested', 'submitted', 'accepted'].includes(input.resolution!) && !workReport) {
        throw new HttpError(409, 'Un rapport de test est obligatoire pour demander sa révision, le soumettre ou accepter cette mission.');
      }
      if (input.resolution === 'in_progress' && workReport) {
        throw new HttpError(409, 'Un rapport existe déjà. Choisissez des modifications demandées pour permettre sa révision.');
      }
      if (input.resolution === 'changes_requested' && !input.revision_note) {
        throw new HttpError(400, 'Précisez les modifications attendues dans une consigne partagée avec les deux participants.');
      }
      run('UPDATE missions SET status=?,decision_note=?,updated_at=? WHERE id=?',
        input.resolution!, input.revision_note ?? 'État révisé par la modération. L’acceptation porte sur le travail réalisé, jamais sur un avis positif.', now(), mission.id);
      notifyParticipants('mission', mission.id, input.resolution === 'cancelled'
        ? 'La modération a annulé cette mission. Aucun versement ni remboursement n’a été effectué.'
        : 'La modération a levé le litige. Consultez votre mission pour poursuivre le processus ; aucun versement automatique n’a été effectué.');
    }
    if (mustResume && order) {
      if (!['paid', 'delivered'].includes(input.resolution!)) throw new HttpError(400, 'Une commande peut reprendre uniquement à l’état payée (démo) ou livrée.');
      if (hasOrderSettlement(order.id)) {
        throw new HttpError(409, 'Une vente ou un remboursement est déjà enregistré. Une correction financière est nécessaire et sort du périmètre de cette démonstration.');
      }
      if (input.resolution === 'delivered' && !order.delivery_text.trim()) {
        throw new HttpError(409, 'Une livraison documentée est obligatoire pour reprendre à l’état livré.');
      }
      if (input.resolution === 'delivered' && order.revision_requested) {
        throw new HttpError(409, 'Des corrections restent attendues : reprenez à l’état payé jusqu’à une nouvelle livraison.');
      }
      run('UPDATE orders SET status=?,version=version+1 WHERE id=?', input.resolution!, order.id);
      appendOrderEvent(order.id, admin.id, 'resumed', input.resolution === 'paid' ? 'Reprise : livraison attendue.' : 'Reprise : livraison à vérifier.');
      notifyParticipants('order', order.id, 'La modération a levé le litige. Consultez votre commande pour poursuivre le processus. Aucun remboursement n’a été effectué.');
    }
    run('UPDATE moderation_reports SET status=?,decision=? WHERE id=?', input.status, input.decision, reportId);
    audit(admin.id, `moderation.report.${input.status}`, 'report', reportId, JSON.stringify({
      target_type: current.target_type, target_id: current.target_id, previous_status: current.status,
      status: input.status, decision: input.decision, previous_target_state: targetStatus ?? null,
      resolution: input.resolution ?? null, other_open_reports: remaining,
      revision_note: input.revision_note ?? null,
    }));
    notify(current.reporter_id, 'moderation', closing ? 'Décision de modération disponible' : 'Votre dossier est en cours d’examen',
      'Consultez votre dossier pour lire la décision. Les autres signalements restent confidentiels.', '/trust');
    return one<Report>('SELECT * FROM moderation_reports WHERE id=?', reportId)!;
  });
  res.json({ report });
});

export default router;
