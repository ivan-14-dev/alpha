import { all, one } from '../db.js';
import { legalDocuments, type LegalDocument } from '../platform/legal.js';
import { log } from '../platform/log.js';
import { personalDataHandlers } from '../platform/privacy.js';
import { hasColumns, stripSecrets, tableExists } from './schema.js';

export const EXPORT_FORMAT_VERSION = 1;

type Section = [name: string, build: (userId: string) => unknown];

/**
 * Core sections of the Art. 15/20 archive. Only data the user provided or that describes them; for shared
 * objects (conversations, orders, reviews received) only identifiers and the parts visible to the user.
 */
const coreSections: Section[] = [
  ['account', (userId) => one<Record<string, unknown>>('SELECT * FROM users WHERE id=?', userId) ?? null],
  ['sessions', (userId) => all(`SELECT ${hasColumns('sessions', 'public_id') ? 'public_id AS id,created_at,' : ''}expires_at
    FROM sessions WHERE user_id=? ORDER BY expires_at DESC`, userId)],
  ['organizations', (userId) => ({
    owned: all('SELECT id,name,description,created_at FROM organizations WHERE owner_id=? ORDER BY created_at', userId),
    memberships: all(`SELECT o.id AS organization_id,o.name,om.role FROM organization_members om JOIN organizations o ON o.id=om.organization_id
      WHERE om.user_id=? ORDER BY o.name`, userId),
    invitations_received: all(`SELECT i.id,i.organization_id,o.name AS organization_name,i.role,i.status,i.created_at,i.responded_at
      FROM organization_invitations i JOIN organizations o ON o.id=i.organization_id WHERE i.invitee_id=? ORDER BY i.created_at`, userId),
    invitations_sent: all(`SELECT id,organization_id,invitee_id,role,status,created_at,responded_at FROM organization_invitations
      WHERE inviter_id=? ORDER BY created_at`, userId),
  })],
  ['projects', (userId) => all(`SELECT id,organization_id,title,summary,description,category,stage,visibility,repo_url,demo_url,tags,color,created_at,updated_at
    FROM projects WHERE owner_id=? ORDER BY created_at`, userId)],
  ['project_tasks', (userId) => all(`SELECT id,project_id,title,description,status,priority,due_at,created_at,updated_at,
    creator_id=? AS created_by_me,assignee_id=? AS assigned_to_me FROM project_tasks WHERE creator_id=? OR assignee_id=? ORDER BY created_at`,
  userId, userId, userId, userId)],
  ['campaigns', (userId) => all(`SELECT c.id,c.project_id,c.title,c.description,c.kind,c.reward_cents,c.slots,c.requirements,c.target_devices,
    c.deadline,c.status,c.created_at,(SELECT COUNT(*) FROM missions m WHERE m.campaign_id=c.id) AS mission_count
    FROM campaigns c WHERE c.owner_id=? ORDER BY c.created_at`, userId)],
  ['applications', (userId) => all(`SELECT a.id,a.campaign_id,c.title AS campaign_title,a.motivation,a.status,a.created_at
    FROM applications a JOIN campaigns c ON c.id=a.campaign_id WHERE a.tester_id=? ORDER BY a.created_at`, userId)],
  ['missions', (userId) => all(`SELECT m.id,m.campaign_id,c.title AS campaign_title,m.status,m.decision_note,m.created_at,m.updated_at,
    r.summary AS report_summary,r.steps AS report_steps,r.expected AS report_expected,r.observed AS report_observed,
    r.evidence_url AS report_evidence_url,r.created_at AS report_created_at,r.updated_at AS report_updated_at
    FROM missions m JOIN campaigns c ON c.id=m.campaign_id LEFT JOIN test_reports r ON r.mission_id=m.id
    WHERE m.tester_id=? ORDER BY m.created_at`, userId)],
  ['missions_on_my_campaigns', (userId) => all(`SELECT m.id,m.campaign_id,m.status,m.created_at,m.updated_at
    FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE c.owner_id=? ORDER BY m.created_at`, userId)],
  ['community', (userId) => ({
    posts: all('SELECT id,group_id,project_id,body,created_at FROM posts WHERE author_id=? ORDER BY created_at', userId),
    comments: all('SELECT id,post_id,body,created_at FROM comments WHERE author_id=? ORDER BY created_at', userId),
    likes: all('SELECT post_id FROM post_likes WHERE user_id=?', userId),
    groups_owned: all('SELECT id,name,description,category,color,created_at FROM groups WHERE owner_id=? ORDER BY created_at', userId),
    group_memberships: all('SELECT g.id,g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=? ORDER BY g.name', userId),
  })],
  ['network', (userId) => ({
    following: all(`SELECT f.following_id AS user_id,u.name,f.created_at FROM user_follows f JOIN users u ON u.id=f.following_id
      WHERE f.follower_id=? ORDER BY f.created_at`, userId),
    followers_count: one<{ total: number }>('SELECT COUNT(*) AS total FROM user_follows WHERE following_id=?', userId)!.total,
    followed_projects: all('SELECT project_id,created_at FROM project_follows WHERE user_id=? ORDER BY created_at', userId),
    bookmarks: all('SELECT target_type,target_id,created_at FROM bookmarks WHERE user_id=? ORDER BY created_at', userId),
  })],
  ['messages', (userId) => ({
    conversations: all(`SELECT c.id,c.subject,c.created_at,c.created_by=? AS created_by_me,
      (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id=c.id) AS participant_count
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=? ORDER BY c.created_at`, userId, userId),
    sent: all('SELECT id,conversation_id,body,created_at FROM messages WHERE sender_id=? ORDER BY created_at', userId),
  })],
  ['marketplace', (userId) => ({
    listings: all(`SELECT id,project_id,title,description,kind,price_cents,license,deliverables,status,created_at
      FROM listings WHERE seller_id=? ORDER BY created_at`, userId),
    purchases: all(`SELECT o.id,o.listing_id,l.title AS listing_title,o.seller_id,o.price_cents,o.status,o.created_at
      FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.buyer_id=? ORDER BY o.created_at`, userId),
    sales: all(`SELECT o.id,o.listing_id,l.title AS listing_title,o.buyer_id,o.price_cents,o.status,o.delivery_text,o.created_at
      FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.seller_id=? ORDER BY o.created_at`, userId),
    order_events: all('SELECT id,order_id,kind,body,order_version,created_at FROM order_events WHERE actor_id=? ORDER BY created_at', userId),
  })],
  ['reviews', (userId) => ({
    written: all(`SELECT id,subject_id,mission_id,rating,communication_rating,quality_rating,body,created_at
      FROM reviews WHERE author_id=? ORDER BY created_at`, userId),
    received: all(`SELECT id,mission_id,rating,communication_rating,quality_rating,body,created_at
      FROM reviews WHERE subject_id=? ORDER BY created_at`, userId),
  })],
  ['moderation_reports', (userId) => all(`SELECT id,target_type,target_id,reason,status,decision,created_at
    FROM moderation_reports WHERE reporter_id=? ORDER BY created_at`, userId)],
  ['notifications', (userId) => all('SELECT id,kind,title,body,link,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at', userId)],
  ['emails', (userId) => all(`SELECT id,category,subject,status,created_at,sent_at FROM email_outbox WHERE user_id=? ORDER BY created_at`, userId)],
  ['audit_events', (userId) => all('SELECT id,action,target_type,target_id,detail,created_at FROM audit_events WHERE actor_id=? ORDER BY created_at', userId)],
  ['demo_transactions', (userId) => all(`SELECT id,campaign_id,mission_id,order_id,kind,amount_cents,status,mode,created_at
    FROM transactions WHERE user_id=? ORDER BY created_at`, userId)],
  ['ledger_entries', (userId) => all(`SELECT e.id,e.account,e.amount_minor,e.currency,e.mode,e.created_at,j.kind,j.ref_type,j.ref_id,j.memo
    FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE e.account IN (?,?) ORDER BY e.created_at,e.id`,
  `user:${userId}:available`, `user:${userId}:pending`)],
  ['legal_acceptances', (userId) => all<{ document: string; version: string; accepted_at: string }>(
    'SELECT document,version,accepted_at FROM legal_acceptances WHERE user_id=? ORDER BY accepted_at', userId)
    .map((row) => ({ ...row, title: legalDocuments[row.document as LegalDocument]?.title ?? row.document }))],
  ['files', (userId) => tableExists('files')
    ? all(`SELECT id,purpose,original_name,mime_type,size_bytes,scan_status,resource_type,resource_id,created_at
      FROM files WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at`, userId)
    : []],
];

export interface ExportArchive {
  format: string;
  version: number;
  generated_at: string;
  user_id: string;
  notice: string;
  sections: Record<string, unknown>;
  modules: Record<string, unknown>;
  errors: { section: string; error: string }[];
}

const notice = 'Export de vos données personnelles (RGPD, articles 15 et 20). Il contient les données que vous avez fournies '
  + 'ou qui vous concernent directement. Les empreintes de mots de passe, jetons de session, secrets et données privées '
  + 'd’autres membres ne sont jamais inclus. Conservez ce fichier en lieu sûr.';

function safely(errors: ExportArchive['errors'], name: string, build: () => unknown): unknown {
  try {
    return stripSecrets(build());
  } catch (error) {
    log.error('privacy.export_section_failed', { section: name, error });
    errors.push({ section: name, error: 'Section indisponible : elle sera incluse dans un prochain export. Contactez le délégué à la protection des données si le problème persiste.' });
    return null;
  }
}

/** Builds the archive on demand (never stored at rest). Each section is isolated so one failure cannot hide the others. */
export function buildExportArchive(userId: string): ExportArchive {
  const errors: ExportArchive['errors'] = [];
  const sections: Record<string, unknown> = {};
  for (const [name, build] of coreSections) sections[name] = safely(errors, name, () => build(userId));
  const modules: Record<string, unknown> = {};
  for (const [name, handler] of personalDataHandlers()) {
    modules[name] = safely(errors, `module:${name}`, () => ({ description: handler.description, data: handler.export(userId) }));
  }
  return {
    format: 'alpha.personal-data-export', version: EXPORT_FORMAT_VERSION, generated_at: new Date().toISOString(),
    user_id: userId, notice, sections, modules, errors,
  };
}

/** Serialises the archive section by section to keep peak memory low for large accounts. */
export function* serializeArchive(archive: ExportArchive): Generator<string> {
  const { sections, modules, ...header } = archive;
  const head = JSON.stringify(header, null, 2);
  yield `${head.slice(0, -2)},\n  "sections": {`;
  let first = true;
  for (const [name, value] of Object.entries(sections)) {
    yield `${first ? '' : ','}\n    ${JSON.stringify(name)}: ${JSON.stringify(value ?? null, null, 2).replace(/\n/g, '\n    ')}`;
    first = false;
  }
  yield '\n  },\n  "modules": {';
  first = true;
  for (const [name, value] of Object.entries(modules)) {
    yield `${first ? '' : ','}\n    ${JSON.stringify(name)}: ${JSON.stringify(value ?? null, null, 2).replace(/\n/g, '\n    ')}`;
    first = false;
  }
  yield '\n  }\n}\n';
}
