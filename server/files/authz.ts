import { all, one } from '../db.js';
import { HttpError } from '../core.js';
import { purposeResource } from './policy.js';
import type { FilePurpose, StoredFile } from './service.js';

/** Authorization rules shared by the HTTP routes and the service contract. */
export function isAdmin(userId: string): boolean {
  return one<{ role: string }>('SELECT role FROM users WHERE id=?', userId)?.role === 'admin';
}

const knownTables = new Set<string>();
export function tableExists(name: string): boolean {
  if (knownTables.has(name)) return true;
  const exists = !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
  if (exists) knownTables.add(name);
  return exists;
}

function columns(table: string): Set<string> {
  return new Set(all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table).map((column) => column.name));
}

/** Buyers keep access to deliveries only for paid, non-cancelled orders. Unknown future statuses deny by default. */
const buyerOrderStatuses = ['paid', 'delivered', 'completed', 'disputed'];

function campaignOwner(campaignId: string): string | undefined {
  return one<{ owner_id: string }>('SELECT owner_id FROM campaigns WHERE id=?', campaignId)?.owner_id;
}

export function isCampaignTester(userId: string, campaignId: string): boolean {
  return !!one(`SELECT 1 FROM applications WHERE campaign_id=? AND tester_id=? AND status='accepted'
    UNION SELECT 1 FROM missions WHERE campaign_id=? AND tester_id=? AND status!='cancelled' LIMIT 1`, campaignId, userId, campaignId, userId);
}

function missionParticipants(missionId: string) {
  return one<{ tester_id: string; owner_id: string; status: string }>(
    'SELECT m.tester_id,c.owner_id,m.status FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?', missionId);
}

function orderParties(orderId: string) {
  return one<{ buyer_id: string; seller_id: string; status: string }>('SELECT buyer_id,seller_id,status FROM orders WHERE id=?', orderId);
}

function isConversationMember(userId: string, conversationId: string): boolean {
  return !!one('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', conversationId, userId);
}

/** sandbox_runs is created by the sandbox module (migration 010); its columns are discovered defensively. */
function sandboxRunReaders(runId: string): string[] {
  if (!tableExists('sandbox_runs')) return [];
  const available = columns('sandbox_runs');
  const requester = ['requested_by', 'requester_id', 'user_id', 'created_by', 'owner_id'].find((column) => available.has(column));
  const readers: string[] = [];
  if (requester) {
    const row = one<Record<string, string | null>>(`SELECT "${requester}" AS requester FROM sandbox_runs WHERE id=?`, runId);
    if (row?.requester) readers.push(row.requester);
  }
  if (available.has('campaign_id')) {
    const row = one<{ owner_id: string | null }>('SELECT c.owner_id FROM sandbox_runs r JOIN campaigns c ON c.id=r.campaign_id WHERE r.id=?', runId);
    if (row?.owner_id) readers.push(row.owner_id);
  } else {
    const fileColumn = ['build_file_id', 'file_id'].find((column) => available.has(column));
    if (fileColumn) {
      const row = one<{ owner_id: string | null }>(`SELECT c.owner_id FROM sandbox_runs r JOIN files f ON f.id=r."${fileColumn}"
        JOIN campaigns c ON f.resource_type='campaign' AND c.id=f.resource_id WHERE r.id=?`, runId);
      if (row?.owner_id) readers.push(row.owner_id);
    }
  }
  return readers;
}

/**
 * Purpose-specific read authorization. Owners can always read metadata (content of quarantined files is
 * refused separately), admins can read everything except privacy exports, which are strictly personal.
 */
export function canReadFileImpl(userId: string, file: StoredFile): boolean {
  if (!userId) return false;
  if (file.purpose === 'privacy_export') return file.owner_id === userId;
  if (file.owner_id === userId) return true;
  if (isAdmin(userId)) return true;
  if (file.purpose === 'kyc_document') return false;
  if (!file.resource_type || !file.resource_id || file.resource_type !== purposeResource[file.purpose]) return false;
  const resourceId = file.resource_id;
  switch (file.purpose) {
    case 'campaign_build':
      return campaignOwner(resourceId) === userId || isCampaignTester(userId, resourceId);
    case 'mission_attachment': {
      const mission = missionParticipants(resourceId);
      return !!mission && (mission.tester_id === userId || mission.owner_id === userId);
    }
    case 'listing_delivery': {
      const order = orderParties(resourceId);
      return !!order && (order.seller_id === userId || (order.buyer_id === userId && buyerOrderStatuses.includes(order.status)));
    }
    case 'message_attachment':
      return isConversationMember(userId, resourceId);
    case 'sandbox_artifact':
      return sandboxRunReaders(resourceId).includes(userId);
    default:
      return false;
  }
}

/**
 * Who may add a file of `purpose` to a resource. Throws a French HttpError (404 for unknown resources,
 * 403 for forbidden ones, 409 for resources in a state that no longer accepts files).
 */
export function assertCanUploadTo(userId: string, purpose: FilePurpose, resourceType: string, resourceId: string) {
  if (purposeResource[purpose] !== resourceType) throw new HttpError(400, 'Ce type de ressource ne correspond pas à l’usage du fichier.');
  switch (purpose) {
    case 'kyc_document':
      if (resourceId !== userId) throw new HttpError(403, 'Vous ne pouvez déposer que vos propres pièces justificatives.');
      return;
    case 'campaign_build': {
      const owner = campaignOwner(resourceId);
      if (!owner) throw new HttpError(404, 'Campagne introuvable.');
      if (owner !== userId) throw new HttpError(403, 'Seul le responsable de la campagne peut publier un build.');
      return;
    }
    case 'mission_attachment': {
      const mission = missionParticipants(resourceId);
      if (!mission) throw new HttpError(404, 'Mission introuvable.');
      if (mission.tester_id !== userId && mission.owner_id !== userId) throw new HttpError(403, 'Seuls le testeur et le responsable de la mission peuvent joindre des fichiers.');
      if (mission.status === 'cancelled') throw new HttpError(409, 'Cette mission est annulée.');
      return;
    }
    case 'listing_delivery': {
      const order = orderParties(resourceId);
      if (!order) throw new HttpError(404, 'Commande introuvable.');
      if (order.seller_id !== userId) throw new HttpError(403, 'Seul le vendeur peut livrer des fichiers pour cette commande.');
      if (order.status !== 'paid') throw new HttpError(409, 'Les fichiers de livraison ne peuvent être ajoutés que sur une commande payée en attente de livraison.');
      return;
    }
    case 'message_attachment':
      if (!one('SELECT 1 FROM conversations WHERE id=?', resourceId)) throw new HttpError(404, 'Conversation introuvable.');
      if (!isConversationMember(userId, resourceId)) throw new HttpError(403, 'Vous ne participez pas à cette conversation.');
      return;
    default:
      throw new HttpError(400, 'Cet usage de fichier est réservé à la plateforme.');
  }
}

/** Front-end link for notifications about a file. */
export function resourceLink(resourceType: string | null, resourceId: string | null): string {
  if (!resourceType || !resourceId) return '/settings';
  switch (resourceType) {
    case 'campaign': return `/missions/${resourceId}`;
    case 'mission': {
      const campaignId = one<{ campaign_id: string }>('SELECT campaign_id FROM missions WHERE id=?', resourceId)?.campaign_id;
      return campaignId ? `/missions/${campaignId}` : '/missions';
    }
    case 'order': return `/marketplace?view=orders&order=${resourceId}`;
    case 'conversation': return `/messages?conversation=${resourceId}`;
    case 'sandbox_run': return `/sandbox/${resourceId}`;
    case 'kyc': return '/wallet';
    default: return '/settings';
  }
}

/** KYC pieces of a dossier never sent for review carry no retention obligation yet (kyc_profiles: compliance migration 008). */
function kycNeverSubmitted(file: StoredFile): boolean {
  if (file.resource_type !== 'kyc' || !file.owner_id || file.resource_id !== file.owner_id || !tableExists('kyc_profiles')) return false;
  const profile = one<{ status: string; submitted_at: string | null }>('SELECT status,submitted_at FROM kyc_profiles WHERE user_id=?', file.owner_id);
  return !profile || (profile.status === 'draft' && !profile.submitted_at);
}

/** Owner deletions that would destroy evidence or legally retained documents are refused. */
export function ownerDeletionBlocker(file: StoredFile): string | null {
  if (file.purpose === 'kyc_document' && file.resource_type && !kycNeverSubmitted(file)) {
    return 'Cette pièce KYC est conservée au titre des obligations légales. Contactez le support.';
  }
  if (file.purpose === 'listing_delivery' && file.resource_id) {
    const order = orderParties(file.resource_id);
    if (order && order.status !== 'paid') return 'Ce fichier a déjà été livré à l’acheteur et ne peut plus être supprimé.';
  }
  if (file.purpose === 'mission_attachment' && file.resource_id) {
    const mission = missionParticipants(file.resource_id);
    if (mission && ['accepted', 'paid', 'disputed'].includes(mission.status)) return 'Cette pièce jointe sert de preuve pour une mission validée ou en litige et ne peut plus être supprimée.';
  }
  return null;
}
