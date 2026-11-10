import { createHash } from 'node:crypto';
import { all, one, run, transaction } from '../db.js';
import { id, now } from '../core.js';
import type { RiskLevel } from '../platform/guards.js';
import { DAY_MS, HOUR_MS, isoAgo, thresholds } from './settings.js';

export const caseKinds = ['multi_account', 'collusion', 'review_ring', 'velocity', 'payment_fraud', 'self_dealing', 'manual'] as const;
export type CaseKind = typeof caseKinds[number];
export const caseStatuses = ['open', 'reviewing', 'actioned', 'dismissed'] as const;
export type CaseStatus = typeof caseStatuses[number];

export interface RiskCaseRow {
  id: string; user_id: string; kind: CaseKind; score: number; status: CaseStatus; summary: string;
  evidence: string; related_user_ids: string; dedupe_key: string; detections: number; assigned_to: string | null;
  resolution_note: string; resolved_by: string | null; created_at: string; updated_at: string;
  last_detected_at: string; resolved_at: string | null;
}

export interface CaseInput {
  kind: CaseKind;
  /** Primary subject (the account the case is filed against). */
  userId: string;
  related: string[];
  score: number;
  summary: string;
  /** Hash prefixes, resource ids and counts only. */
  evidence: Record<string, unknown>;
  dedupeKey: string;
  /** Group patterns (review rings): reuse any active case of the same kind sharing a subject. */
  matchOverlap?: boolean;
}

export interface UpsertResult { id: string; created: boolean; changed: boolean }

export const shortHash = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : null);
export const groupKey = (userIds: string[]) => createHash('sha256').update([...new Set(userIds)].sort().join(',')).digest('hex').slice(0, 32);
const clampScore = (score: number) => Math.max(0, Math.min(100, Math.round(score)));
const parseIds = (value: string): string[] => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []; } catch { return []; } };

function existingUsers(ids: string[]): string[] {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 200);
  if (!unique.length) return [];
  const found = new Set(all<{ id: string }>(`SELECT id FROM users WHERE id IN (${unique.map(() => '?').join(',')})`, ...unique).map((row) => row.id));
  return unique.filter((userId) => found.has(userId));
}

export function caseSubjects(caseId: string): string[] {
  return all<{ user_id: string }>('SELECT user_id FROM risk_case_subjects WHERE case_id=? ORDER BY role DESC,user_id', caseId).map((row) => row.user_id);
}

function linkSubjects(caseId: string, primary: string, related: string[]) {
  run("INSERT INTO risk_case_subjects(case_id,user_id,role) VALUES (?,?,'primary') ON CONFLICT(case_id,user_id) DO UPDATE SET role='primary'", caseId, primary);
  for (const userId of related) {
    if (userId !== primary) run("INSERT OR IGNORE INTO risk_case_subjects(case_id,user_id,role) VALUES (?,?,'related')", caseId, userId);
  }
}

function overlapping(kind: CaseKind, userIds: string[], statuses: CaseStatus[], since?: string) {
  if (!userIds.length) return [];
  return all<RiskCaseRow>(`SELECT DISTINCT c.* FROM risk_case_subjects s JOIN risk_cases c ON c.id=s.case_id
    WHERE c.kind=? AND c.status IN (${statuses.map(() => '?').join(',')}) AND s.user_id IN (${userIds.map(() => '?').join(',')})
    ${since ? 'AND c.resolved_at>=?' : ''} ORDER BY c.created_at LIMIT 20`, kind, ...statuses, ...userIds, ...(since ? [since] : []));
}

/**
 * Idempotent case creation (detectors run every 10 minutes and inline): one active case per dedupe key.
 * An active case is refreshed (score = max, related subjects merged); a recently closed case with the same
 * subjects is not re-opened during the dismissal cooldown. Call inside or outside a transaction.
 */
export function upsertCase(input: CaseInput): UpsertResult | null {
  return transaction(() => {
    const subjects = existingUsers([input.userId, ...input.related]);
    if (!subjects.includes(input.userId)) return null;
    const related = subjects.filter((userId) => userId !== input.userId);
    const score = clampScore(input.score);
    const timestamp = now();
    const active = one<RiskCaseRow>("SELECT * FROM risk_cases WHERE dedupe_key=? AND status IN ('open','reviewing')", input.dedupeKey)
      ?? (input.matchOverlap ? overlapping(input.kind, subjects, ['open', 'reviewing'])[0] : undefined);
    if (active) {
      const known = new Set(caseSubjects(active.id));
      const grown = subjects.some((userId) => !known.has(userId));
      const changed = grown || score > active.score;
      if (changed) {
        const mergedRelated = [...new Set([...parseIds(active.related_user_ids), ...related])].filter((userId) => userId !== active.user_id).slice(0, 100);
        const evidence = { ...safeJson(active.evidence), ...input.evidence };
        run(`UPDATE risk_cases SET score=?,summary=?,evidence=?,related_user_ids=?,detections=detections+1,updated_at=?,last_detected_at=? WHERE id=?`,
          Math.max(score, active.score), input.summary.slice(0, 500), JSON.stringify(evidence), JSON.stringify(mergedRelated), timestamp, timestamp, active.id);
        linkSubjects(active.id, active.user_id, subjects);
      } else {
        run('UPDATE risk_cases SET last_detected_at=? WHERE id=?', timestamp, active.id);
      }
      return { id: active.id, created: false, changed };
    }
    const cooldownDays = thresholds().dismissed_cooldown_days;
    if (cooldownDays > 0) {
      const since = isoAgo(cooldownDays * DAY_MS);
      const closed = [
        ...all<RiskCaseRow>("SELECT * FROM risk_cases WHERE dedupe_key=? AND status IN ('actioned','dismissed') AND resolved_at>=? ORDER BY resolved_at DESC LIMIT 5", input.dedupeKey, since),
        ...(input.matchOverlap ? overlapping(input.kind, subjects, ['actioned', 'dismissed'], since) : []),
      ];
      if (closed.some((row) => { const covered = new Set(caseSubjects(row.id)); return subjects.every((userId) => covered.has(userId)); })) return null;
    }
    const caseId = id();
    run(`INSERT INTO risk_cases(id,user_id,kind,score,status,summary,evidence,related_user_ids,dedupe_key,created_at,updated_at,last_detected_at)
      VALUES (?,?,?,?,'open',?,?,?,?,?,?,?)`, caseId, input.userId, input.kind, score, input.summary.slice(0, 500),
    JSON.stringify(input.evidence), JSON.stringify(related.slice(0, 100)), input.dedupeKey.slice(0, 200), timestamp, timestamp, timestamp);
    linkSubjects(caseId, input.userId, subjects);
    return { id: caseId, created: true, changed: true };
  });
}

export function safeJson(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export const parseUserIds = parseIds;

const activeSanctionSql = (alias: string, at: string) => `EXISTS (SELECT 1 FROM sanctions s WHERE s.user_id=${alias}.id AND s.revoked_at IS NULL
  AND s.kind IN ('suspension','ban') AND s.starts_at<='${at}' AND (s.ends_at IS NULL OR s.ends_at>'${at}'))`;

/**
 * SQL expression computing the risk level of `users ${alias}`. Literals only come from Date.toISOString()
 * and integer settings, so the expression is safe to inline (it is shared by riskLevel() and the admin list).
 */
export function riskLevelSql(alias = 'u'): string {
  const at = new Date().toISOString();
  const failedSince = isoAgo(24 * HOUR_MS);
  const failedLimit = Math.trunc(thresholds().failed_logins_per_hour);
  const score = `COALESCE((SELECT MAX(c.score) FROM risk_case_subjects cs JOIN risk_cases c ON c.id=cs.case_id
    WHERE cs.user_id=${alias}.id AND c.status IN ('open','reviewing')),0)`;
  const failed = `(SELECT COUNT(*) FROM risk_signals rs WHERE rs.user_id=${alias}.id AND rs.kind IN ('login_failed','mfa_failed') AND rs.created_at>='${failedSince}')`;
  return `(CASE WHEN ${score}>=70 OR ${activeSanctionSql(alias, at)} THEN 'high'
    WHEN ${score}>=40 OR ${failed}>=${failedLimit} THEN 'medium' ELSE 'low' END)`;
}

export function riskLevelOf(userId: string): RiskLevel {
  return one<{ level: RiskLevel }>(`SELECT ${riskLevelSql('u')} AS level FROM users u WHERE u.id=?`, userId)?.level ?? 'low';
}

export function maxOpenScore(userId: string): number {
  return one<{ score: number | null }>(`SELECT MAX(c.score) AS score FROM risk_case_subjects cs JOIN risk_cases c ON c.id=cs.case_id
    WHERE cs.user_id=? AND c.status IN ('open','reviewing')`, userId)?.score ?? 0;
}
