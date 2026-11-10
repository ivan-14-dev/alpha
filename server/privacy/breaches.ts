import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, now } from '../core.js';
import { BREACH_NOTIFICATION_HOURS } from './settings.js';

/** Art. 33/34 RGPD: every personal data breach is documented here, even when it is not notified. */
export const breachNatures = ['confidentiality', 'integrity', 'availability'] as const;

const isoDate = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), 'Date invalide.')
  .transform((value) => new Date(value).toISOString());
const optionalDate = z.union([isoDate, z.null()]);
const labelList = z.array(z.string().trim().min(1).max(120)).max(30);

export const breachInput = z.object({
  title: z.string().trim().min(3, 'Titre trop court.').max(200),
  detected_at: isoDate,
  occurred_at: optionalDate.optional(),
  description: z.string().trim().min(1, 'Décrivez l’incident.').max(10000),
  nature: z.array(z.enum(breachNatures)).max(3).default([]),
  data_categories: labelList.default([]),
  affected_count: z.number().int().min(0).max(1_000_000_000).default(0),
  risk_level: z.enum(['none', 'risk', 'high']).default('risk'),
  consequences: z.string().trim().max(10000).default(''),
  measures: z.string().trim().max(10000).default(''),
  notified_cnil_at: optionalDate.optional(),
  cnil_reference: z.string().trim().max(200).default(''),
  notified_users_at: optionalDate.optional(),
  status: z.enum(['open', 'closed']).default('open'),
}).strict();
export const breachPatch = breachInput.partial().strict();

interface BreachRow {
  id: string; title: string; detected_at: string; occurred_at: string | null; description: string; nature: string; data_categories: string;
  affected_count: number; risk_level: 'none' | 'risk' | 'high'; consequences: string; measures: string; notified_cnil_at: string | null;
  cnil_reference: string; notified_users_at: string | null; status: 'open' | 'closed'; created_by: string | null; created_by_name?: string | null;
  created_at: string; updated_at: string;
}

/**
 * 72-hour indicator (Art. 33.1). `not_required` only when the breach is assessed as unlikely to result in a risk.
 * Users must also be informed without undue delay when the risk is high (Art. 34).
 */
export function breachDeadline(row: Pick<BreachRow, 'detected_at' | 'risk_level' | 'notified_cnil_at' | 'notified_users_at'>, at = Date.now()) {
  const deadline = Date.parse(row.detected_at) + BREACH_NOTIFICATION_HOURS * 3600000;
  const base = { deadline: new Date(deadline).toISOString(), hours_left: null as number | null };
  const users_notification_required = row.risk_level === 'high';
  const users_pending = users_notification_required && !row.notified_users_at;
  if (row.risk_level === 'none') return { ...base, state: 'not_required' as const, users_notification_required, users_pending };
  if (row.notified_cnil_at) {
    return { ...base, state: Date.parse(row.notified_cnil_at) <= deadline ? 'notified_on_time' as const : 'notified_late' as const, users_notification_required, users_pending };
  }
  if (at > deadline) return { ...base, state: 'overdue' as const, users_notification_required, users_pending };
  return { ...base, state: 'pending' as const, hours_left: Math.max(0, Math.floor((deadline - at) / 3600000)), users_notification_required, users_pending };
}

function view(row: BreachRow) {
  return { ...row, nature: JSON.parse(row.nature) as string[], data_categories: JSON.parse(row.data_categories) as string[], deadline: breachDeadline(row) };
}

const select = `SELECT b.*,u.name AS created_by_name FROM breach_register b LEFT JOIN users u ON u.id=b.created_by`;

export function listBreaches() {
  return all<BreachRow>(`${select} ORDER BY b.status='open' DESC,b.detected_at DESC LIMIT 500`).map(view);
}

export function getBreach(breachId: string) {
  const row = one<BreachRow>(`${select} WHERE b.id=?`, breachId);
  if (!row) throw new HttpError(404, 'Incident introuvable.');
  return view(row);
}

function validateChronology(value: { detected_at?: string; occurred_at?: string | null; notified_cnil_at?: string | null; notified_users_at?: string | null }) {
  if (value.detected_at && Date.parse(value.detected_at) > Date.now() + 5 * 60000) throw new HttpError(400, 'La date de détection ne peut pas être dans le futur.');
  if (value.occurred_at && value.detected_at && value.occurred_at > value.detected_at) throw new HttpError(400, 'La date de survenue doit précéder la détection.');
  for (const key of ['notified_cnil_at', 'notified_users_at'] as const) {
    if (value[key] && value.detected_at && value[key]! < value.detected_at) throw new HttpError(400, 'Une notification ne peut pas précéder la détection.');
  }
}

export function createBreach(adminId: string, input: z.infer<typeof breachInput>) {
  validateChronology(input);
  return transaction(() => {
    const breachId = id();
    run(`INSERT INTO breach_register(id,title,detected_at,occurred_at,description,nature,data_categories,affected_count,risk_level,consequences,
      measures,notified_cnil_at,cnil_reference,notified_users_at,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    breachId, input.title, input.detected_at, input.occurred_at ?? null, input.description, JSON.stringify(input.nature),
    JSON.stringify(input.data_categories), input.affected_count, input.risk_level, input.consequences, input.measures,
    input.notified_cnil_at ?? null, input.cnil_reference, input.notified_users_at ?? null, input.status, adminId, now(), now());
    audit(adminId, 'privacy.admin.breach_created', 'breach', breachId, JSON.stringify({ risk_level: input.risk_level, affected_count: input.affected_count }));
    return getBreach(breachId);
  });
}

export function updateBreach(adminId: string, breachId: string, patch: z.infer<typeof breachPatch>) {
  return transaction(() => {
    const current = getBreach(breachId);
    const merged = { ...current, ...patch };
    validateChronology(merged);
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (!fields.length) return current;
    const values = fields.map((field) => {
      const value = patch[field];
      return Array.isArray(value) ? JSON.stringify(value) : value ?? null;
    });
    run(`UPDATE breach_register SET ${fields.map((field) => `${field}=?`).join(',')},updated_at=? WHERE id=?`, ...values, now(), breachId);
    audit(adminId, 'privacy.admin.breach_updated', 'breach', breachId, JSON.stringify({ fields }));
    return getBreach(breachId);
  });
}

/** Entries are evidence (Art. 33.5): deletion is only allowed shortly after creation, to fix a mistaken entry. */
export function deleteBreach(adminId: string, breachId: string) {
  transaction(() => {
    const current = getBreach(breachId);
    if (Date.now() - Date.parse(current.created_at) > 24 * 3600000) {
      throw new HttpError(409, 'Un incident enregistré depuis plus de 24 heures ne peut plus être supprimé : clôturez-le en documentant la raison.');
    }
    run('DELETE FROM breach_register WHERE id=?', breachId);
    audit(adminId, 'privacy.admin.breach_deleted', 'breach', breachId, JSON.stringify({ title: current.title }));
  });
}
