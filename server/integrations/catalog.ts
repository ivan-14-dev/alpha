import { one } from '../db.js';

/**
 * Public outgoing-webhook event catalogue. Internal audit actions are mapped to stable public types; payloads
 * are minimal (ids, statuses, titles) and never contain private messages, e-mails, motivations, report
 * contents or amounts that do not belong to the endpoint owner.
 */
export const eventCatalog = [
  { type: 'project.updated', group: 'Projet', label: 'Projet modifié' },
  { type: 'task.created', group: 'Projet', label: 'Tâche créée' },
  { type: 'task.updated', group: 'Projet', label: 'Tâche modifiée' },
  { type: 'campaign.created', group: 'Tests', label: 'Campagne créée' },
  { type: 'campaign.funded', group: 'Tests', label: 'Campagne financée' },
  { type: 'application.created', group: 'Tests', label: 'Candidature reçue' },
  { type: 'application.accepted', group: 'Tests', label: 'Candidature acceptée' },
  { type: 'application.rejected', group: 'Tests', label: 'Candidature refusée' },
  { type: 'mission.started', group: 'Tests', label: 'Mission démarrée' },
  { type: 'report.submitted', group: 'Tests', label: 'Rapport de test soumis' },
  { type: 'report.revised', group: 'Tests', label: 'Rapport de test révisé' },
  { type: 'mission.changes_requested', group: 'Tests', label: 'Corrections demandées' },
  { type: 'mission.accepted', group: 'Tests', label: 'Mission acceptée' },
  { type: 'mission.disputed', group: 'Tests', label: 'Mission contestée' },
  { type: 'mission.paid', group: 'Tests', label: 'Mission payée' },
  { type: 'listing.created', group: 'Marketplace', label: 'Offre publiée' },
  { type: 'listing.updated', group: 'Marketplace', label: 'Offre modifiée' },
  { type: 'listing.archived', group: 'Marketplace', label: 'Offre archivée' },
  { type: 'order.created', group: 'Marketplace', label: 'Commande reçue' },
  { type: 'order.delivered', group: 'Marketplace', label: 'Commande livrée' },
  { type: 'order.revision_requested', group: 'Marketplace', label: 'Révision demandée' },
  { type: 'order.disputed', group: 'Marketplace', label: 'Commande contestée' },
  { type: 'order.completed', group: 'Marketplace', label: 'Commande terminée' },
  { type: 'source.push', group: 'Sources', label: 'Push sur la branche par défaut' },
  { type: 'source.release', group: 'Sources', label: 'Nouvelle version publiée' },
] as const;

export type PublicEventType = (typeof eventCatalog)[number]['type'];
export const publicEventTypes = eventCatalog.map((item) => item.type) as [PublicEventType, ...PublicEventType[]];
const publicTypeSet = new Set<string>(publicEventTypes);

const aliases: Record<string, PublicEventType> = {
  'marketplace.purchased': 'order.created',
  'marketplace.completed': 'order.completed',
  'listing.edited': 'listing.updated',
};

/** `demo.campaign.funded` / `sandbox.…` / `live.…` / `marketplace.order.delivered` → public type (or null). */
export function publicEventType(action: string): PublicEventType | null {
  let base = action.replace(/^(demo|sandbox|live)\./, '');
  if (aliases[base]) return aliases[base];
  base = base.replace(/^marketplace\./, '');
  if (aliases[base]) return aliases[base];
  return publicTypeSet.has(base) && !base.startsWith('source.') ? base as PublicEventType : null;
}

interface ProjectRef { project_id: string | null }

/** Resolves the project concerned by an audited target (null when not project-scoped or already deleted). */
export function resolveProjectId(targetType: string, targetId: string): string | null {
  const sql: Record<string, string> = {
    project: 'SELECT id AS project_id FROM projects WHERE id=?',
    campaign: 'SELECT project_id FROM campaigns WHERE id=?',
    application: 'SELECT c.project_id FROM applications a JOIN campaigns c ON c.id=a.campaign_id WHERE a.id=?',
    mission: 'SELECT c.project_id FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?',
    listing: 'SELECT project_id FROM listings WHERE id=?',
    order: 'SELECT l.project_id FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.id=?',
    project_task: 'SELECT project_id FROM project_tasks WHERE id=?',
  };
  const query = sql[targetType];
  if (!query) return null;
  return one<ProjectRef>(query, targetId)?.project_id ?? null;
}

/** Builds the `data` object for one endpoint owner. Returns null when the target vanished. */
export function buildEventData(type: PublicEventType, targetType: string, targetId: string, ownerId: string, projectId: string): Record<string, unknown> | null {
  if (targetType === 'project') {
    const project = one<{ id: string; title: string; stage: string; visibility: string; updated_at: string }>(
      'SELECT id,title,stage,visibility,updated_at FROM projects WHERE id=?', targetId);
    return project ? { project_id: projectId, project } : null;
  }
  if (targetType === 'project_task') {
    const task = one<{ id: string; title: string; status: string; priority: string; assignee_id: string | null; due_at: string | null; updated_at: string }>(
      'SELECT id,title,status,priority,assignee_id,due_at,updated_at FROM project_tasks WHERE id=?', targetId);
    return task ? { project_id: projectId, task } : null;
  }
  if (targetType === 'campaign') {
    const campaign = one<{ id: string; owner_id: string; title: string; status: string; slots: number; deadline: string; reward_cents: number }>(
      'SELECT id,owner_id,title,status,slots,deadline,reward_cents FROM campaigns WHERE id=?', targetId);
    if (!campaign) return null;
    const { owner_id: campaignOwner, reward_cents: reward, ...rest } = campaign;
    return { project_id: projectId, campaign: { ...rest, ...(campaignOwner === ownerId ? { reward_cents: reward } : {}) } };
  }
  if (targetType === 'application') {
    const application = one<{ id: string; campaign_id: string; tester_id: string; status: string; created_at: string }>(
      'SELECT id,campaign_id,tester_id,status,created_at FROM applications WHERE id=?', targetId);
    return application ? { project_id: projectId, campaign_id: application.campaign_id, application } : null;
  }
  if (targetType === 'mission') {
    const mission = one<{ id: string; campaign_id: string; tester_id: string; status: string; updated_at: string }>(
      'SELECT id,campaign_id,tester_id,status,updated_at FROM missions WHERE id=?', targetId);
    if (!mission) return null;
    if (type === 'report.submitted' || type === 'report.revised') {
      const report = one<{ id: string; updated_at: string }>('SELECT id,updated_at FROM test_reports WHERE mission_id=?', targetId);
      return { project_id: projectId, campaign_id: mission.campaign_id, mission_id: mission.id, report: report ?? null, mission };
    }
    return { project_id: projectId, campaign_id: mission.campaign_id, mission };
  }
  if (targetType === 'listing') {
    const listing = one<{ id: string; seller_id: string; title: string; kind: string; status: string; price_cents: number }>(
      'SELECT id,seller_id,title,kind,status,price_cents FROM listings WHERE id=?', targetId);
    if (!listing) return null;
    const { seller_id: seller, price_cents: price, ...rest } = listing;
    return { project_id: projectId, listing: { ...rest, ...(seller === ownerId ? { price_cents: price } : {}) } };
  }
  if (targetType === 'order') {
    const order = one<{ id: string; listing_id: string; seller_id: string; status: string; price_cents: number; created_at: string }>(
      'SELECT id,listing_id,seller_id,status,price_cents,created_at FROM orders WHERE id=?', targetId);
    if (!order) return null;
    const { seller_id: seller, price_cents: price, ...rest } = order;
    return { project_id: projectId, listing_id: order.listing_id, order: { ...rest, ...(seller === ownerId ? { price_cents: price } : {}) } };
  }
  return null;
}
