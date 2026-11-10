import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, notify, now } from '../core.js';
import type { Capability, Restriction } from '../platform/guards.js';
import { queueEmail, renderEmail } from '../platform/mailer.js';

export const CAPABILITIES = ['login', 'publish', 'message', 'trade', 'money', 'withdraw', 'review', 'test'] as const satisfies readonly Capability[];
/** Capabilities a sanction can list. `login` is only ever blocked by a non-appealable ban. */
export const RESTRICTABLE: Capability[] = CAPABILITIES.filter((capability) => capability !== 'login');
export const sanctionKinds = ['warning', 'restriction', 'suspension', 'ban'] as const;
export type SanctionKind = typeof sanctionKinds[number];
export const severity: Record<SanctionKind, number> = { warning: 1, restriction: 2, suspension: 3, ban: 4 };

export const capabilityLabels: Record<Capability, string> = {
  login: 'Connexion',
  publish: 'Publication (projets, communauté, fichiers)',
  message: 'Messagerie',
  trade: 'Marketplace (achats et ventes)',
  money: 'Paiements',
  withdraw: 'Retraits',
  review: 'Avis',
  test: 'Missions de test et bac à sable',
};

export const kindLabels: Record<SanctionKind, string> = {
  warning: 'Avertissement', restriction: 'Restriction', suspension: 'Suspension', ban: 'Bannissement',
};

/** DSA art. 17(3)(d)-(e): contractual or legal ground of each decision. */
export const groundLabels = {
  'terms.fraud': 'Conditions d’utilisation — fraude ou tentative de fraude',
  'terms.multi_account': 'Conditions d’utilisation — comptes multiples ou usurpation',
  'terms.fake_reviews': 'Conditions d’utilisation — avis non authentiques',
  'terms.self_dealing': 'Conditions d’utilisation — transactions fictives ou avec soi-même',
  'terms.payment_abuse': 'Conditions d’utilisation — abus des moyens de paiement',
  'terms.harassment': 'Conditions d’utilisation — harcèlement ou comportement abusif',
  'terms.spam': 'Conditions d’utilisation — spam ou sollicitations abusives',
  'terms.security': 'Sécurité du compte — mesure conservatoire',
  'terms.other': 'Conditions d’utilisation — autre manquement',
  'law.illegal_content': 'Contenu ou activité illicite (droit applicable)',
} as const;
export type Ground = keyof typeof groundLabels;
export const groundKeys = Object.keys(groundLabels) as [Ground, ...Ground[]];

export interface SanctionRow {
  id: string; user_id: string; kind: SanctionKind; capabilities: string; ground: string; public_reason: string;
  internal_note: string; starts_at: string; ends_at: string | null; appealable: number; automated: number;
  created_by: string | null; case_id: string | null; revoked_at: string | null; revoked_by: string | null;
  revoked_reason: string; created_at: string;
}

export const capabilitiesOf = (row: Pick<SanctionRow, 'capabilities'>): Capability[] => {
  try {
    const parsed = JSON.parse(row.capabilities);
    return Array.isArray(parsed) ? parsed.filter((item): item is Capability => (CAPABILITIES as readonly string[]).includes(item)) : [];
  } catch { return []; }
};

export const isActive = (row: Pick<SanctionRow, 'revoked_at' | 'starts_at' | 'ends_at'>, at = now()) =>
  !row.revoked_at && row.starts_at <= at && (!row.ends_at || row.ends_at > at);

/** Active (started, not ended, not revoked) sanctions of a user. Uses the sanctions_user_active index. */
export function activeSanctions(userId: string, at = now()): SanctionRow[] {
  return all<SanctionRow>(`SELECT * FROM sanctions WHERE user_id=? AND revoked_at IS NULL AND starts_at<=? AND (ends_at IS NULL OR ends_at>?)
    ORDER BY created_at DESC LIMIT 50`, userId, at, at);
}

/**
 * Most severe active sanction blocking `capability`. `null` = a mutation without a mapped capability, which only
 * a suspension or a ban blocks. `login` is blocked exclusively by a non-appealable ban, so suspended members can
 * still sign in to read the statement of reasons and appeal.
 */
export function blockingSanction(userId: string, capability: Capability | null): SanctionRow | undefined {
  const blocking = activeSanctions(userId).filter((row) => {
    if (row.kind === 'warning') return false;
    if (capability === 'login') return row.kind === 'ban' && row.appealable === 0;
    if (row.kind === 'ban' || row.kind === 'suspension') return true;
    return capability !== null && capabilitiesOf(row).includes(capability);
  });
  return blocking.sort((left, right) => severity[right.kind] - severity[left.kind]
    || (left.ends_at === null ? -1 : right.ends_at === null ? 1 : right.ends_at.localeCompare(left.ends_at)))[0];
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' });
export const frenchDate = (value: string) => dateFormat.format(new Date(value));
const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function restrictionMessage(row: SanctionRow, capability: Capability | null): string {
  const until = row.ends_at ? ` jusqu’au ${frenchDate(row.ends_at)}` : '';
  const reason = `Motif : ${sentence(row.public_reason)}`;
  const head = row.kind === 'ban'
    ? `Votre compte est banni${until || ' sans limite de durée'}.`
    : row.kind === 'suspension'
      ? `Votre compte est suspendu${until}.`
      : `Votre compte est restreint pour cette action (${capability ? capabilityLabels[capability] : 'action'})${until}.`;
  const redress = row.appealable ? ' Vous pouvez contester cette décision depuis la page Confiance (/trust).' : ' Cette décision n’est pas contestable en interne.';
  return `${head} ${reason}${redress}`;
}

export function restrictionOf(row: SanctionRow, capability: Capability | null): Restriction {
  return {
    sanction_id: row.id,
    kind: row.kind,
    message: restrictionMessage(row, capability),
    until: row.ends_at,
    appealable: row.appealable === 1,
    ...(capability ? { capability } : {}),
  };
}

/** Audit with an optional actor (automatic measures are recorded with a NULL actor). */
export function auditAs(actorId: string | null, action: string, targetType: string, targetId: string, detail: Record<string, unknown>) {
  if (actorId) audit(actorId, action, targetType, targetId, JSON.stringify(detail));
  else run('INSERT INTO audit_events (id,actor_id,action,target_type,target_id,detail) VALUES (?,NULL,?,?,?,?)', id(), action, targetType, targetId, JSON.stringify(detail));
}

export interface SanctionInput {
  userId: string;
  kind: SanctionKind;
  capabilities?: Capability[];
  publicReason: string;
  internalNote?: string;
  ground?: Ground;
  endsAt?: string | null;
  appealable?: boolean;
  createdBy: string | null;
  caseId?: string | null;
  automated?: boolean;
}

export function normalizeCapabilities(kind: SanctionKind, capabilities: Capability[] = []): Capability[] {
  if (kind === 'warning') return [];
  if (kind === 'suspension' || kind === 'ban') return [...RESTRICTABLE];
  return RESTRICTABLE.filter((capability) => capabilities.includes(capability));
}

const titles: Record<SanctionKind, string> = {
  warning: 'Avertissement de la modération',
  restriction: 'Restriction appliquée à votre compte',
  suspension: 'Votre compte est suspendu',
  ban: 'Votre compte est banni',
};

/** Creates a sanction with its statement of reasons. Call inside the caller's transaction. */
export function createSanction(input: SanctionInput): SanctionRow {
  return transaction(() => {
    const user = one<{ id: string; email: string; name: string }>('SELECT id,email,name FROM users WHERE id=?', input.userId);
    if (!user) throw new HttpError(404, 'Membre introuvable.');
    const capabilities = normalizeCapabilities(input.kind, input.capabilities);
    if (input.kind === 'restriction' && !capabilities.length) throw new HttpError(400, 'Choisissez au moins une capacité à restreindre.');
    const appealable = input.appealable ?? true;
    if (!appealable && input.kind !== 'ban') throw new HttpError(400, 'Seul un bannissement peut être rendu non contestable.');
    const startsAt = now();
    if (input.endsAt && input.endsAt <= startsAt) throw new HttpError(400, 'La date de fin doit être dans le futur.');
    const reason = input.publicReason.trim();
    if (reason.length < 10 || reason.length > 2000) throw new HttpError(400, 'Le motif communiqué au membre doit contenir entre 10 et 2000 caractères.');
    const sanctionId = id();
    run(`INSERT INTO sanctions(id,user_id,kind,capabilities,ground,public_reason,internal_note,starts_at,ends_at,appealable,automated,created_by,case_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, sanctionId, user.id, input.kind, JSON.stringify(capabilities), input.ground ?? 'terms.other',
    reason, (input.internalNote ?? '').trim().slice(0, 4000), startsAt, input.endsAt ?? null, appealable ? 1 : 0, input.automated ? 1 : 0,
    input.createdBy, input.caseId ?? null, startsAt);
    let revokedSessions = 0;
    if (input.kind === 'ban') revokedSessions = Number(run('DELETE FROM sessions WHERE user_id=?', user.id).changes);
    const redress = appealable ? 'Vous pouvez contester cette décision depuis la page Confiance.' : 'Cette décision n’est pas contestable en interne ; les recours extrajudiciaires et judiciaires restent ouverts.';
    notify(user.id, 'trust.sanction', titles[input.kind], `${sentence(reason)} ${redress}`, '/trust#restrictions');
    if (input.kind === 'ban' || input.kind === 'suspension') {
      const until = input.endsAt ? `Jusqu’au ${frenchDate(input.endsAt)}.` : 'Sans date de fin.';
      const email = renderEmail({
        title: titles[input.kind],
        paragraphs: [
          `Bonjour ${user.name},`,
          `Motif : ${sentence(reason)}`,
          `Fondement : ${groundLabels[input.ground ?? 'terms.other']}. ${until}`,
          input.automated ? 'Cette mesure a été prise à la suite d’une détection automatisée.' : 'Cette décision a été prise par l’équipe de modération.',
          redress,
        ],
        action: appealable ? { label: 'Voir la décision et contester', url: '/trust#restrictions' } : undefined,
      });
      queueEmail({ to: user.email, userId: user.id, category: 'trust.sanction', subject: `Alpha — ${titles[input.kind]}`, text: email.text, html: email.html });
    }
    auditAs(input.createdBy, 'trust.sanction.created', 'user', user.id, {
      sanction_id: sanctionId, kind: input.kind, capabilities, ground: input.ground ?? 'terms.other', ends_at: input.endsAt ?? null,
      appealable, automated: !!input.automated, case_id: input.caseId ?? null, revoked_sessions: revokedSessions,
    });
    return one<SanctionRow>('SELECT * FROM sanctions WHERE id=?', sanctionId)!;
  });
}

/** Lifts a sanction (pending appeals on it are closed as accepted). Call inside the caller's transaction. */
export function revokeSanction(sanctionId: string, actorId: string | null, reason: string, options: { appealId?: string; notifyUser?: boolean } = {}): SanctionRow {
  return transaction(() => {
    const sanction = one<SanctionRow>('SELECT * FROM sanctions WHERE id=?', sanctionId);
    if (!sanction) throw new HttpError(404, 'Sanction introuvable.');
    if (sanction.revoked_at) throw new HttpError(409, 'Cette sanction est déjà levée.');
    const timestamp = now();
    const text = reason.trim().slice(0, 2000);
    run('UPDATE sanctions SET revoked_at=?,revoked_by=?,revoked_reason=? WHERE id=? AND revoked_at IS NULL', timestamp, actorId, text, sanctionId);
    const closed = Number(run(`UPDATE appeals SET status='accepted',reviewer_id=?,decision_note=?,decided_at=?
      WHERE sanction_id=? AND status='pending' ${options.appealId ? 'AND id!=?' : ''}`,
    actorId, `Sanction levée : ${text}`.slice(0, 4000), timestamp, sanctionId, ...(options.appealId ? [options.appealId] : [])).changes);
    if (options.notifyUser !== false) notify(sanction.user_id, 'trust.sanction', 'Sanction levée', `${kindLabels[sanction.kind]} levée. ${sentence(text)}`, '/trust#restrictions');
    auditAs(actorId, 'trust.sanction.revoked', 'user', sanction.user_id, { sanction_id: sanctionId, kind: sanction.kind, reason: text, closed_appeals: closed, appeal_id: options.appealId ?? null });
    return one<SanctionRow>('SELECT * FROM sanctions WHERE id=?', sanctionId)!;
  });
}

/** Member-facing statement of reasons (DSA art. 17): never includes the internal note or the author. */
export function publicSanction(row: SanctionRow, at = now()) {
  return {
    id: row.id,
    kind: row.kind,
    kind_label: kindLabels[row.kind],
    capabilities: capabilitiesOf(row),
    capability_labels: capabilitiesOf(row).map((capability) => capabilityLabels[capability]),
    login_blocked: row.kind === 'ban' && row.appealable === 0,
    ground: row.ground,
    ground_label: groundLabels[row.ground as Ground] ?? row.ground,
    public_reason: row.public_reason,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    appealable: row.appealable === 1,
    automated_detection: !!row.case_id,
    automated_decision: row.automated === 1,
    active: isActive(row, at),
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_at ? row.revoked_reason : '',
    created_at: row.created_at,
  };
}
