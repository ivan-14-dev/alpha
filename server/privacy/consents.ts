import { all, one, run, transaction } from '../db.js';
import { id, now } from '../core.js';
import { legalDocuments } from '../platform/legal.js';

/**
 * Opt-in consents (Art. 6.1.a / 7). No row = not granted. Every change is appended to `consent_events`
 * together with the privacy policy version shown to the user, so consent can be proven (Art. 7.1).
 */
export const consentPurposes = ['marketing_email', 'product_updates', 'analytics'] as const;
export type ConsentPurpose = typeof consentPurposes[number];
export type ConsentSource = 'settings' | 'registration' | 'admin' | 'erasure' | 'api';

export const consentDescriptions: Record<ConsentPurpose, { label: string; description: string }> = {
  marketing_email: {
    label: 'E-mails promotionnels',
    description: 'Offres, événements et sélections de projets envoyés par Alpha. Sans ce consentement, vous ne recevez que les e-mails nécessaires au service (sécurité, paiements, missions).',
  },
  product_updates: {
    label: 'Nouveautés du produit',
    description: 'Annonces des nouvelles fonctionnalités et invitations à des tests de la plateforme.',
  },
  analytics: {
    label: 'Mesure d’audience',
    description: 'Statistiques d’usage agrégées pour améliorer Alpha. Aucun traceur publicitaire n’est utilisé ; la mesure reste désactivée tant que vous ne l’activez pas.',
  },
};

export const currentPolicyVersion = () => legalDocuments.privacy.version;

/** Helper for other modules: e.g. only send marketing e-mails when `hasConsent(userId, 'marketing_email')`. */
export function hasConsent(userId: string, purpose: ConsentPurpose): boolean {
  return !!one('SELECT 1 FROM consents WHERE user_id=? AND purpose=? AND granted=1', userId, purpose);
}

export interface ConsentState {
  purpose: ConsentPurpose;
  label: string;
  description: string;
  granted: boolean;
  policy_version: string | null;
  updated_at: string | null;
  source: string | null;
  /** Given under an older privacy policy version: shown to the user so they can confirm it. */
  outdated: boolean;
}

export function consentsFor(userId: string): ConsentState[] {
  const rows = all<{ purpose: ConsentPurpose; granted: number; policy_version: string; updated_at: string; source: string }>(
    'SELECT purpose,granted,policy_version,updated_at,source FROM consents WHERE user_id=?', userId);
  const version = currentPolicyVersion();
  return consentPurposes.map((purpose) => {
    const row = rows.find((item) => item.purpose === purpose);
    return {
      purpose, ...consentDescriptions[purpose],
      granted: !!row?.granted,
      policy_version: row?.policy_version ?? null,
      updated_at: row?.updated_at ?? null,
      source: row?.source ?? null,
      outdated: !!row?.granted && row.policy_version !== version,
    };
  });
}

export function consentHistory(userId: string, limit = 100) {
  return all<{ id: string; purpose: ConsentPurpose; granted: number; policy_version: string; source: string; created_at: string }>(
    'SELECT id,purpose,granted,policy_version,source,created_at FROM consent_events WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?',
    userId, limit).map((event) => ({ ...event, granted: !!event.granted }));
}

/**
 * Applies the given changes and records one history event per actual change (re-confirming a consent given
 * under an older policy version also counts as a change). Returns the purposes that changed.
 */
export function setConsents(userId: string, changes: Partial<Record<ConsentPurpose, boolean>>, source: ConsentSource): ConsentPurpose[] {
  return transaction(() => {
    const version = currentPolicyVersion();
    const changed: ConsentPurpose[] = [];
    for (const purpose of consentPurposes) {
      const wanted = changes[purpose];
      if (wanted === undefined) continue;
      const current = one<{ granted: number; policy_version: string }>('SELECT granted,policy_version FROM consents WHERE user_id=? AND purpose=?', userId, purpose);
      const granted = wanted ? 1 : 0;
      if (current && current.granted === granted && (!granted || current.policy_version === version)) continue;
      if (!current && !granted) continue;
      const timestamp = now();
      run(`INSERT INTO consents(user_id,purpose,granted,policy_version,source,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id,purpose) DO UPDATE SET granted=excluded.granted,policy_version=excluded.policy_version,source=excluded.source,updated_at=excluded.updated_at`,
      userId, purpose, granted, version, source, timestamp);
      run('INSERT INTO consent_events(id,user_id,purpose,granted,policy_version,source,created_at) VALUES (?,?,?,?,?,?,?)',
        id(), userId, purpose, granted, version, source, timestamp);
      changed.push(purpose);
    }
    return changed;
  });
}

/** Erasure: withdraws every consent (history kept as proof, linked to the anonymized id only). */
export function withdrawAllConsents(userId: string) {
  const granted = all<{ purpose: ConsentPurpose }>('SELECT purpose FROM consents WHERE user_id=? AND granted=1', userId);
  setConsents(userId, Object.fromEntries(granted.map((row) => [row.purpose, false])), 'erasure');
  run('DELETE FROM consents WHERE user_id=?', userId);
}
