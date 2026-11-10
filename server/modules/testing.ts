import { Router, type Request } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, canManageProject, canReadProject, HttpError, id, notify, now, param, requireUser, safeUrl } from '../core.js';
import { campaignBudget } from '../payments/core/budget.js';
import { campaignPaymentMode, payMissionFromEscrow, refundCampaignEscrow } from '../payments/escrow.js';
import { paymentMode } from '../payments/mode.js';

const router = Router();
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Identifiant invalide.');
const resourceId = (req: Request) => identifier.parse(param(req));
const kinds = ['usability', 'functional', 'accessibility', 'performance'] as const;
const campaignInput = z.object({
  project_id: identifier,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(20).max(10000),
  kind: z.enum(kinds).default('usability'),
  reward_cents: z.number().int().positive().max(1_000_000),
  slots: z.number().int().min(1).max(100),
  requirements: z.string().trim().max(3000).default(''),
  target_devices: z.string().trim().min(1).max(300).default('Web'),
  deadline: z.string().max(50).datetime({ offset: true })
    .refine((value) => Date.parse(value) > Date.now(), 'Choisissez une échéance future.')
    .transform((value) => new Date(value).toISOString()),
});
const reportInput = z.object({
  summary: z.string().trim().min(10).max(4000),
  steps: z.string().trim().min(10).max(10000),
  expected: z.string().trim().min(5).max(5000),
  observed: z.string().trim().min(5).max(5000),
  evidence_url: z.union([z.literal(''), z.string().url().max(2000)]).pipe(safeUrl).default(''),
});
const reasonInput = z.object({ reason: z.string().trim().min(10).max(3000) });

interface Campaign {
  id: string; project_id: string; owner_id: string; title: string; description: string;
  kind: string; reward_cents: number; slots: number; requirements: string; target_devices: string;
  deadline: string; status: string; created_at: string; project_title: string;
  project_visibility: string; owner_name: string; assigned_count: number; payment_mode: 'demo' | 'sandbox' | 'live';
}
interface Application {
  id: string; campaign_id: string; tester_id: string; motivation: string; status: string; created_at: string;
}
interface Mission {
  id: string; campaign_id: string; tester_id: string; application_id: string; status: string;
  decision_note: string; created_at: string; updated_at: string; owner_id: string;
  campaign_title: string; project_id: string; project_title: string; reward_cents: number;
  tester_name: string; tester_color: string; deadline: string; owner_name: string;
}
interface Report {
  id: string; mission_id: string; summary: string; steps: string; expected: string;
  observed: string; evidence_url: string; created_at: string; updated_at: string;
}
const campaignSelect = `SELECT c.*, p.title AS project_title, p.visibility AS project_visibility,
  u.name AS owner_name,
  (SELECT COUNT(*) FROM missions m WHERE m.campaign_id=c.id AND m.status!='cancelled') AS assigned_count
  FROM campaigns c JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.owner_id`;
const missionSelect = `SELECT m.*, c.owner_id, c.title AS campaign_title, c.project_id, c.reward_cents,
  c.deadline, c.payment_mode, p.title AS project_title, u.name AS tester_name, u.avatar_color AS tester_color,
  owner.name AS owner_name FROM missions m JOIN campaigns c ON c.id=m.campaign_id
  JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=m.tester_id
  JOIN users owner ON owner.id=c.owner_id`;

function getCampaign(campaignId: string): Campaign {
  const campaign = one<Campaign>(`${campaignSelect} WHERE c.id=?`, campaignId);
  if (!campaign) throw new HttpError(404, 'Campagne introuvable.');
  return campaign;
}
function readableCampaign(campaignId: string, userId?: string): Campaign {
  const campaign = getCampaign(campaignId);
  if (campaign.owner_id !== userId && !canReadProject(userId, campaign.project_id)) {
    throw new HttpError(404, 'Campagne introuvable.');
  }
  return campaign;
}
function openCampaign(campaign: Campaign) {
  if (campaign.status !== 'open' || Date.parse(campaign.deadline) <= Date.now()) {
    throw new HttpError(409, 'Cette campagne est fermée ou son échéance est dépassée.');
  }
}
function getMission(missionId: string, userId: string): Mission {
  const mission = one<Mission>(`${missionSelect} WHERE m.id=?`, missionId);
  if (!mission) throw new HttpError(404, 'Mission introuvable.');
  if (mission.tester_id !== userId && mission.owner_id !== userId) {
    throw new HttpError(403, 'Cette mission est réservée au testeur et au responsable.');
  }
  return mission;
}
function missionWithReport(mission: Mission) {
  return { ...mission, report: one<Report>('SELECT * FROM test_reports WHERE mission_id=?', mission.id) ?? null };
}
function ownerOnly(ownerId: string, userId: string) {
  if (ownerId !== userId) throw new HttpError(403, 'Seul le responsable de la campagne peut effectuer cette action.');
}
function testerOnly(mission: Mission, userId: string) {
  if (mission.tester_id !== userId) throw new HttpError(403, 'Seul le testeur assigné peut effectuer cette action.');
}
function requireStatus(mission: Mission, statuses: string[]) {
  if (!statuses.includes(mission.status)) throw new HttpError(409, 'Cette action n’est pas possible à cette étape de la mission.');
}
function updateMission(missionId: string, status: string, note = '') {
  run('UPDATE missions SET status=?,decision_note=?,updated_at=? WHERE id=?', status, note, now(), missionId);
}

router.get('/campaigns', (req, res) => {
  const query = z.object({
    project: identifier.optional(),
    q: z.string().trim().max(100).optional(),
    kind: z.enum(kinds).optional(),
  }).parse(req.query);
  const userId = req.user?.id ?? '';
  const campaigns = all<Campaign>(`${campaignSelect} WHERE
    (p.visibility='public' OR c.owner_id=? OR p.owner_id=?
      OR EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id=p.organization_id AND om.user_id=?)
      OR EXISTS (SELECT 1 FROM campaigns selected JOIN missions m ON m.campaign_id=selected.id
        WHERE selected.project_id=p.id AND m.tester_id=? AND m.status!='cancelled'))
    AND (? IS NULL OR c.project_id=?) AND (? IS NULL OR c.kind=?)
    AND (? IS NULL OR c.title LIKE ? OR p.title LIKE ?)
    ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,
  userId, userId, userId, userId, query.project ?? null, query.project ?? null,
  query.kind ?? null, query.kind ?? null, query.q ?? null, `%${query.q ?? ''}%`, `%${query.q ?? ''}%`);
  const managed_projects = req.user ? all<{ id: string; title: string }>(
    `SELECT p.id,p.title FROM projects p WHERE p.owner_id=? OR EXISTS
      (SELECT 1 FROM organization_members om WHERE om.organization_id=p.organization_id
       AND om.user_id=? AND om.role IN ('owner','admin')) ORDER BY p.title LIMIT 100`, userId, userId) : [];
  res.json({ campaigns, managed_projects });
});

router.post('/campaigns', (req, res) => {
  const user = requireUser(req);
  const input = campaignInput.parse(req.body);
  if (!one('SELECT id FROM projects WHERE id=?', input.project_id)) throw new HttpError(404, 'Projet introuvable.');
  if (!canManageProject(user.id, input.project_id)) throw new HttpError(403, 'Vous devez gérer ce projet pour créer une campagne.');
  const campaignId = id();
  transaction(() => {
    run(`INSERT INTO campaigns (id,project_id,owner_id,title,description,kind,reward_cents,slots,requirements,target_devices,deadline)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, campaignId, input.project_id, user.id, input.title, input.description,
    input.kind, input.reward_cents, input.slots, input.requirements, input.target_devices, input.deadline);
    audit(user.id, 'campaign.created', 'campaign', campaignId);
  });
  res.status(201).json({ campaign: getCampaign(campaignId), balance: campaignBudget(campaignId) });
});

router.get('/campaigns/:id', (req, res) => {
  const campaign = readableCampaign(resourceId(req), req.user?.id);
  const isOwner = campaign.owner_id === req.user?.id;
  const application = req.user ? one<Pick<Application, 'id' | 'status' | 'created_at'>>(
    'SELECT id,status,created_at FROM applications WHERE campaign_id=? AND tester_id=?', campaign.id, req.user.id) ?? null : null;
  const missions = req.user ? all<Mission>(`${missionSelect} WHERE m.campaign_id=? AND (m.tester_id=? OR c.owner_id=?)
    ORDER BY m.created_at DESC LIMIT 100`, campaign.id, req.user.id, req.user.id).map(missionWithReport) : [];
  res.json({
    campaign, application, missions,
    ...(isOwner ? {
      applications: all<Application & { tester_name: string; tester_title: string; tester_color: string; tester_skills: string }>(
        `SELECT a.*,u.name AS tester_name,u.title AS tester_title,u.avatar_color AS tester_color,u.skills AS tester_skills
        FROM applications a JOIN users u ON u.id=a.tester_id WHERE a.campaign_id=?
        ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END,a.created_at LIMIT 200`, campaign.id),
      balance: campaignBudget(campaign.id),
    } : {}),
  });
});

router.post('/campaigns/:id/applications', (req, res) => {
  const user = requireUser(req);
  const campaignId = resourceId(req);
  const { motivation } = z.object({ motivation: z.string().trim().min(20).max(3000) }).parse(req.body);
  const applicationId = id();
  transaction(() => {
    const campaign = readableCampaign(campaignId, user.id);
    if (campaign.owner_id === user.id) throw new HttpError(403, 'Vous ne pouvez pas postuler à votre propre campagne.');
    openCampaign(campaign);
    if (one('SELECT id FROM applications WHERE campaign_id=? AND tester_id=?', campaignId, user.id)) {
      throw new HttpError(409, 'Vous avez déjà postulé à cette campagne.');
    }
    if (campaign.assigned_count >= campaign.slots) throw new HttpError(409, 'Toutes les places sont déjà attribuées.');
    run('INSERT INTO applications (id,campaign_id,tester_id,motivation) VALUES (?,?,?,?)', applicationId, campaignId, user.id, motivation);
    notify(campaign.owner_id, 'application', 'Nouvelle candidature', `${user.name} souhaite tester « ${campaign.title} ».`, `/missions/${campaignId}`);
    audit(user.id, 'application.created', 'application', applicationId);
  });
  res.status(201).json({ application: { id: applicationId, status: 'pending' } });
});

router.post('/applications/:id/accept', (req, res) => {
  const user = requireUser(req);
  const applicationId = resourceId(req);
  const missionId = id();
  const campaignId = transaction(() => {
    const application = one<Application>('SELECT * FROM applications WHERE id=?', applicationId);
    if (!application) throw new HttpError(404, 'Candidature introuvable.');
    const campaign = getCampaign(application.campaign_id);
    ownerOnly(campaign.owner_id, user.id);
    if (application.tester_id === user.id) throw new HttpError(403, 'Vous ne pouvez pas vous attribuer votre propre campagne.');
    if (application.status !== 'pending') throw new HttpError(409, 'Cette candidature a déjà été traitée.');
    openCampaign(campaign);
    if (campaign.assigned_count >= campaign.slots) throw new HttpError(409, 'Toutes les places sont déjà attribuées.');
    if (campaignBudget(campaign.id).available_cents < campaign.reward_cents) {
      throw new HttpError(409, campaign.payment_mode === 'demo' && paymentMode() === 'demo'
        ? 'Financez le budget de démonstration avant de sélectionner un testeur.'
        : 'Financez le budget de la campagne (séquestre) avant de sélectionner un testeur.');
    }
    run("UPDATE applications SET status='accepted' WHERE id=?", applicationId);
    run('INSERT INTO missions (id,campaign_id,tester_id,application_id) VALUES (?,?,?,?)',
      missionId, campaign.id, application.tester_id, applicationId);
    notify(application.tester_id, 'mission', 'Votre candidature est retenue', campaign.title, `/missions/${campaign.id}`);
    audit(user.id, 'application.accepted', 'application', applicationId);
    return campaign.id;
  });
  res.status(201).json({ mission: missionWithReport(getMission(missionId, user.id)), balance: campaignBudget(campaignId) });
});

router.post('/campaigns/:id/close', (req, res) => {
  const user = requireUser(req);
  const campaignId = resourceId(req);
  const { reason } = z.object({ reason: z.string().trim().max(500).default('') }).strict().parse(req.body ?? {});
  const refund = transaction(() => {
    const campaign = getCampaign(campaignId);
    ownerOnly(campaign.owner_id, user.id);
    if (campaign.status === 'closed') throw new HttpError(409, 'Cette campagne est déjà fermée.');
    run("UPDATE campaigns SET status='closed' WHERE id=?", campaign.id);
    audit(user.id, 'campaign.closed', 'campaign', campaign.id, reason);
    if (campaign.payment_mode === 'demo') return null;
    const budget = campaignBudget(campaign.id);
    // Missions in progress keep their reserved reward; only the unused escrow goes back to the payer.
    return budget.available_cents > 0 ? refundCampaignEscrow(campaign.id, user.id, reason || 'Clôture de la campagne : solde non utilisé') : null;
  });
  res.json({ campaign: getCampaign(campaignId), balance: campaignBudget(campaignId), refund });
});

router.post('/applications/:id/reject', (req, res) => {
  const user = requireUser(req);
  const applicationId = resourceId(req);
  transaction(() => {
    const application = one<Application>('SELECT * FROM applications WHERE id=?', applicationId);
    if (!application) throw new HttpError(404, 'Candidature introuvable.');
    const campaign = getCampaign(application.campaign_id);
    ownerOnly(campaign.owner_id, user.id);
    if (application.status !== 'pending') throw new HttpError(409, 'Cette candidature a déjà été traitée.');
    run("UPDATE applications SET status='rejected' WHERE id=?", applicationId);
    notify(application.tester_id, 'application', 'Candidature non retenue', campaign.title, `/missions/${campaign.id}`);
    audit(user.id, 'application.rejected', 'application', applicationId);
  });
  res.json({ application: { id: applicationId, status: 'rejected' } });
});

router.get('/missions', (req, res) => {
  const user = requireUser(req);
  const query = z.object({ campaign: identifier.optional() }).parse(req.query);
  const missions = all<Mission>(`${missionSelect} WHERE (m.tester_id=? OR c.owner_id=?)
    AND (? IS NULL OR m.campaign_id=?) ORDER BY m.updated_at DESC,m.id DESC LIMIT 100`,
  user.id, user.id, query.campaign ?? null, query.campaign ?? null).map(missionWithReport);
  res.json({ missions });
});

router.post('/missions/:id/start', (req, res) => {
  const user = requireUser(req);
  const missionId = resourceId(req);
  transaction(() => {
    const mission = getMission(missionId, user.id);
    testerOnly(mission, user.id);
    requireStatus(mission, ['assigned']);
    updateMission(missionId, 'in_progress');
    notify(mission.owner_id, 'mission', 'Les tests ont commencé', mission.campaign_title, `/missions/${mission.campaign_id}`);
    audit(user.id, 'mission.started', 'mission', missionId);
  });
  res.json({ mission: missionWithReport(getMission(missionId, user.id)) });
});

router.post('/missions/:id/report', (req, res) => {
  const user = requireUser(req);
  const missionId = resourceId(req);
  const input = reportInput.parse(req.body);
  transaction(() => {
    const mission = getMission(missionId, user.id);
    testerOnly(mission, user.id);
    requireStatus(mission, ['assigned', 'in_progress', 'changes_requested']);
    const existing = one<Report>('SELECT * FROM test_reports WHERE mission_id=?', missionId);
    if ((existing && mission.status !== 'changes_requested') || (!existing && mission.status === 'changes_requested')) {
      throw new HttpError(409, 'Le rapport ne peut pas être modifié dans cet état.');
    }
    if (existing) {
      if (Object.entries(input).every(([key, value]) => existing[key as keyof Report] === value)) {
        throw new HttpError(409, 'Modifiez votre rapport pour répondre aux corrections demandées.');
      }
      run('UPDATE test_reports SET summary=?,steps=?,expected=?,observed=?,evidence_url=?,updated_at=? WHERE mission_id=?',
        input.summary, input.steps, input.expected, input.observed, input.evidence_url, now(), missionId);
    } else {
      run('INSERT INTO test_reports (id,mission_id,summary,steps,expected,observed,evidence_url) VALUES (?,?,?,?,?,?,?)',
        id(), missionId, input.summary, input.steps, input.expected, input.observed, input.evidence_url);
    }
    updateMission(missionId, 'submitted');
    notify(mission.owner_id, 'report', existing ? 'Rapport corrigé' : 'Nouveau rapport de test', mission.campaign_title, `/missions/${mission.campaign_id}`);
    audit(user.id, existing ? 'report.revised' : 'report.submitted', 'mission', missionId);
  });
  res.json({ mission: missionWithReport(getMission(missionId, user.id)) });
});

router.post('/missions/:id/accept', (req, res) => {
  const user = requireUser(req);
  const missionId = resourceId(req);
  transaction(() => {
    const mission = getMission(missionId, user.id);
    ownerOnly(mission.owner_id, user.id);
    requireStatus(mission, ['submitted']);
    if (!one('SELECT id FROM test_reports WHERE mission_id=?', missionId)) throw new HttpError(409, 'Aucun rapport à valider.');
    updateMission(missionId, 'accepted');
    const realMoney = campaignPaymentMode(mission.campaign_id) !== 'demo';
    notify(mission.tester_id, 'mission', 'Votre rapport est validé', realMoney
      ? 'Votre récompense est versée depuis le séquestre de la campagne.'
      : 'Le versement de démonstration peut maintenant être déclenché.', `/missions/${mission.campaign_id}`);
    audit(user.id, 'mission.accepted', 'mission', missionId);
    // Real-money campaigns pay the tester from escrow atomically with the acceptance.
    if (realMoney) payMissionFromEscrow(missionId, user.id);
  });
  res.json({ mission: missionWithReport(getMission(missionId, user.id)) });
});

router.post('/missions/:id/changes', (req, res) => {
  const user = requireUser(req);
  const missionId = resourceId(req);
  const { reason } = reasonInput.parse(req.body);
  transaction(() => {
    const mission = getMission(missionId, user.id);
    ownerOnly(mission.owner_id, user.id);
    requireStatus(mission, ['submitted']);
    if (!one('SELECT id FROM test_reports WHERE mission_id=?', missionId)) throw new HttpError(409, 'Aucun rapport à corriger.');
    updateMission(missionId, 'changes_requested', reason);
    notify(mission.tester_id, 'mission', 'Corrections demandées', reason, `/missions/${mission.campaign_id}`);
    audit(user.id, 'mission.changes_requested', 'mission', missionId);
  });
  res.json({ mission: missionWithReport(getMission(missionId, user.id)) });
});

router.post('/missions/:id/dispute', (req, res) => {
  const user = requireUser(req);
  const missionId = resourceId(req);
  const { reason } = reasonInput.parse(req.body);
  const reportId = id();
  transaction(() => {
    const mission = getMission(missionId, user.id);
    requireStatus(mission, ['assigned', 'in_progress', 'submitted', 'changes_requested', 'accepted']);
    if (one("SELECT id FROM moderation_reports WHERE target_type='mission' AND target_id=? AND status IN ('open','reviewing')", missionId)) {
      throw new HttpError(409, 'Un litige est déjà en cours pour cette mission.');
    }
    run("INSERT INTO moderation_reports (id,reporter_id,target_type,target_id,reason) VALUES (?,?,'mission',?,?)",
      reportId, user.id, missionId, reason);
    updateMission(missionId, 'disputed', 'Mission suspendue pour examen par la modération.');
    notify(user.id === mission.owner_id ? mission.tester_id : mission.owner_id, 'dispute',
      'Un litige a été ouvert', 'Le versement est suspendu pendant l’examen par la modération.', `/missions/${mission.campaign_id}`);
    audit(user.id, 'mission.disputed', 'mission', missionId, reportId);
  });
  res.status(201).json({ mission: missionWithReport(getMission(missionId, user.id)), moderation_report: { id: reportId, status: 'open' } });
});

export default router;
