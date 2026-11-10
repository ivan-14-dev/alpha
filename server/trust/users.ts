import { all, one, run, transaction } from '../db.js';
import { HttpError, notify, now, type User } from '../core.js';
import { parseUserIds, riskLevelOf, riskLevelSql, safeJson, type RiskCaseRow } from './cases.js';
import { activeSanctions, auditAs, capabilitiesOf, createSanction, kindLabels, type SanctionInput, type SanctionRow } from './sanctions.js';
import { appealSettings, DAY_MS } from './settings.js';

let verifiedColumn: boolean | null = null;
/** `users.email_verified_at` is added by the accounts migration; tolerate its absence. */
function hasVerifiedColumn() {
  if (verifiedColumn) return true;
  verifiedColumn = !!one("SELECT 1 FROM pragma_table_info('users') WHERE name='email_verified_at'");
  return verifiedColumn;
}

const statusSql = (alias: string, at: string) => `COALESCE((SELECT CASE s.kind WHEN 'ban' THEN 'banned' WHEN 'suspension' THEN 'suspended'
    WHEN 'restriction' THEN 'restricted' ELSE 'warned' END FROM sanctions s WHERE s.user_id=${alias}.id AND s.revoked_at IS NULL
    AND s.starts_at<='${at}' AND (s.ends_at IS NULL OR s.ends_at>'${at}')
    ORDER BY CASE s.kind WHEN 'ban' THEN 4 WHEN 'suspension' THEN 3 WHEN 'restriction' THEN 2 ELSE 1 END DESC LIMIT 1),'active')`;

export const userStatuses = ['active', 'warned', 'restricted', 'suspended', 'banned'] as const;
export interface UserFilters { q?: string; role?: 'member' | 'admin'; status?: typeof userStatuses[number]; risk?: 'low' | 'medium' | 'high'; limit: number; offset: number }

export function listUsers(filters: UserFilters) {
  const at = new Date().toISOString();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (filters.role) { where.push('u.role=?'); params.push(filters.role); }
  const inner = `SELECT u.id,u.name,u.email,u.role,u.avatar_color,u.created_at,
      ${hasVerifiedColumn() ? 'u.email_verified_at IS NOT NULL' : '0'} AS email_verified,
      (SELECT COUNT(*) FROM sanctions s WHERE s.user_id=u.id) AS sanctions_count,
      ${statusSql('u', at)} AS status, ${riskLevelSql('u')} AS risk_level
    FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const outer: string[] = [];
  if (filters.status) { outer.push('status=?'); params.push(filters.status); }
  if (filters.risk) { outer.push('risk_level=?'); params.push(filters.risk); }
  const filtered = `SELECT * FROM (${inner}) ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}`;
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM (${filtered})`, ...params)!.total;
  const users = all<{ email_verified: number } & Record<string, unknown>>(`${filtered} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
    ...params, filters.limit, filters.offset).map((row) => ({ ...row, email_verified: !!row.email_verified }));
  return { users, total, limit: filters.limit, offset: filters.offset, has_more: filters.offset + users.length < total };
}

function linkedAccounts(userId: string) {
  const linked = new Map<string, { user_id: string; name: string; role: string; via: Set<string>; hashes: Set<string>; last_seen: string }>();
  for (const column of ['device_hash', 'ip_hash'] as const) {
    const scope = column === 'ip_hash' ? "AND ip_scope='public'" : '';
    const rows = all<{ user_id: string; name: string; role: string; hashes: string; last_seen: string }>(
      `WITH mine AS (SELECT DISTINCT ${column} AS hash FROM risk_signals WHERE user_id=? AND ${column} IS NOT NULL ${scope})
       SELECT r.user_id,u.name,u.role,GROUP_CONCAT(DISTINCT substr(r.${column},1,12)) AS hashes,MAX(r.created_at) AS last_seen
       FROM risk_signals r JOIN mine ON mine.hash=r.${column} JOIN users u ON u.id=r.user_id
       WHERE r.user_id!=? GROUP BY r.user_id ORDER BY last_seen DESC LIMIT 50`, userId, userId);
    for (const row of rows) {
      const entry = linked.get(row.user_id) ?? { user_id: row.user_id, name: row.name, role: row.role, via: new Set(), hashes: new Set(), last_seen: row.last_seen };
      entry.via.add(column === 'device_hash' ? 'device' : 'ip');
      for (const hash of row.hashes.split(',')) entry.hashes.add(hash);
      if (row.last_seen > entry.last_seen) entry.last_seen = row.last_seen;
      linked.set(row.user_id, entry);
    }
  }
  return [...linked.values()].map((entry) => ({ ...entry, via: [...entry.via], hashes: [...entry.hashes].slice(0, 10) }));
}

export function adminSanctionView(row: SanctionRow & { created_by_name?: string | null; revoked_by_name?: string | null }) {
  return { ...row, capabilities: capabilitiesOf(row), appealable: row.appealable === 1, automated: row.automated === 1, kind_label: kindLabels[row.kind] };
}

export function caseView<T extends RiskCaseRow>(row: T) {
  return { ...row, evidence: safeJson(row.evidence), related_user_ids: parseUserIds(row.related_user_ids) };
}

export function userDetail(userId: string) {
  const user = one<Record<string, unknown>>(`SELECT id,name,email,title,role,avatar_color,created_at,
    ${hasVerifiedColumn() ? 'email_verified_at' : 'NULL AS email_verified_at'} FROM users WHERE id=?`, userId);
  if (!user) throw new HttpError(404, 'Membre introuvable.');
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const signals = {
    by_kind: all<{ kind: string; total: number; last_30_days: number; last_at: string }>(`SELECT kind,COUNT(*) AS total,
      SUM(created_at>=?) AS last_30_days,MAX(created_at) AS last_at FROM risk_signals WHERE user_id=? GROUP BY kind ORDER BY total DESC`, since, userId),
    hashes: one<{ devices: number; ips: number; user_agents: number; first_at: string | null; last_at: string | null }>(`SELECT
      COUNT(DISTINCT device_hash) AS devices,COUNT(DISTINCT CASE WHEN ip_scope='public' THEN ip_hash END) AS ips,
      COUNT(DISTINCT ua_hash) AS user_agents,MIN(created_at) AS first_at,MAX(created_at) AS last_at FROM risk_signals WHERE user_id=?`, userId),
    linked_accounts: linkedAccounts(userId),
  };
  const cases = all<RiskCaseRow & Record<string, unknown>>(`SELECT c.*,cs.role AS subject_role FROM risk_case_subjects cs JOIN risk_cases c ON c.id=cs.case_id
    WHERE cs.user_id=? ORDER BY CASE WHEN c.status IN ('open','reviewing') THEN 0 ELSE 1 END,c.score DESC,c.created_at DESC LIMIT 50`, userId).map(caseView);
  const sanctions = all<SanctionRow & { created_by_name: string | null; revoked_by_name: string | null }>(`SELECT s.*,cb.name AS created_by_name,rb.name AS revoked_by_name
    FROM sanctions s LEFT JOIN users cb ON cb.id=s.created_by LEFT JOIN users rb ON rb.id=s.revoked_by WHERE s.user_id=? ORDER BY s.created_at DESC LIMIT 100`, userId)
    .map((row) => ({ ...adminSanctionView(row), active: activeSanctions(userId).some((active) => active.id === row.id) }));
  const appeals = all(`SELECT a.*,r.name AS reviewer_name FROM appeals a LEFT JOIN users r ON r.id=a.reviewer_id WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT 100`, userId);
  const sessions = one<{ count: number }>('SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND expires_at>?', userId, now())!.count;
  return {
    user: { ...user, email_verified: !!user.email_verified_at },
    risk_level: riskLevelOf(userId), signals, cases, sanctions, appeals, active_sessions: sessions,
    appeal_sla_days: appealSettings().sla_days,
  };
}

const freshRole = (userId: string) => one<{ role: 'member' | 'admin' }>('SELECT role FROM users WHERE id=?', userId)?.role;

/** Role change with self-demotion and last-admin protection, re-checked against the stored state. */
export function setUserRole(actor: User, targetId: string, role: 'member' | 'admin') {
  return transaction(() => {
    if (freshRole(actor.id) !== 'admin') throw new HttpError(403, 'Acces reserve a la moderation.');
    const target = one<{ id: string; role: 'member' | 'admin' }>('SELECT id,role FROM users WHERE id=?', targetId);
    if (!target) throw new HttpError(404, 'Membre introuvable.');
    if (target.id === actor.id && role !== 'admin') throw new HttpError(409, 'Vous ne pouvez pas retirer vos propres droits d’administration.');
    if (target.role === role) return { id: target.id, role, changed: false };
    if (target.role === 'admin' && one<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND id!=?", target.id)!.count < 1) {
      throw new HttpError(409, 'Au moins un administrateur doit rester sur la plateforme.');
    }
    if (role === 'admin' && activeSanctions(target.id).some((row) => row.kind === 'suspension' || row.kind === 'ban')) {
      throw new HttpError(409, 'Levez d’abord la suspension ou le bannissement de ce compte.');
    }
    run('UPDATE users SET role=? WHERE id=?', role, target.id);
    auditAs(actor.id, 'trust.user.role_changed', 'user', target.id, { from: target.role, to: role });
    notify(target.id, 'trust.role', role === 'admin' ? 'Droits d’administration accordés' : 'Droits d’administration retirés',
      role === 'admin' ? 'Vous avez désormais accès à l’espace d’administration.' : 'Votre compte est revenu au rôle membre.', role === 'admin' ? '/admin' : '/');
    return { id: target.id, role, changed: true };
  });
}

/** Admin-issued sanction with the self / other-admin guards. */
export function adminSanction(actor: User, input: Omit<SanctionInput, 'createdBy' | 'automated'> & { confirmAdmin?: boolean }) {
  return transaction(() => {
    if (freshRole(actor.id) !== 'admin') throw new HttpError(403, 'Acces reserve a la moderation.');
    if (input.userId === actor.id) throw new HttpError(409, 'Vous ne pouvez pas vous sanctionner vous-même.');
    const targetRole = freshRole(input.userId);
    if (!targetRole) throw new HttpError(404, 'Membre introuvable.');
    if (targetRole === 'admin' && !input.confirmAdmin) {
      throw new HttpError(409, 'Ce compte est administrateur : confirmez explicitement la sanction d’un autre administrateur.');
    }
    const { confirmAdmin: _confirm, ...sanction } = input;
    return createSanction({ ...sanction, createdBy: actor.id, automated: false });
  });
}

export function revokeUserSessions(actor: User, userId: string) {
  return transaction(() => {
    if (!one('SELECT 1 FROM users WHERE id=?', userId)) throw new HttpError(404, 'Membre introuvable.');
    const revoked = Number(run('DELETE FROM sessions WHERE user_id=?', userId).changes);
    auditAs(actor.id, 'trust.user.sessions_revoked', 'user', userId, { revoked });
    return { revoked };
  });
}
