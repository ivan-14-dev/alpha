import { all, run } from '../db.js';
import { registerPersonalData } from '../platform/privacy.js';
import { memberAppeal, type AppealRow } from './appeals.js';
import { publicSanction, type SanctionRow } from './sanctions.js';

/**
 * GDPR: members receive their own statements of reasons and appeals (never internal notes, authors, other
 * members' data nor the content of risk cases, whose disclosure would defeat fraud prevention — art. 23 GDPR).
 * Erasure deletes risk signals and dismissed cases filed against the member; sanctions and appeals are kept as
 * legitimate-interest records (proof of decisions, DSA statements of reasons, repeat-abuse prevention) until
 * `trust.retention.sanctions_years` after their end.
 */
registerPersonalData('trust', {
  description: 'Sanctions, appels et signaux anti-fraude (empreintes chiffrées, aucune adresse IP en clair).',
  export(userId) {
    const sanctions = all<SanctionRow>('SELECT * FROM sanctions WHERE user_id=? ORDER BY created_at DESC', userId).map((row) => publicSanction(row));
    const appeals = all<AppealRow>('SELECT * FROM appeals WHERE user_id=? ORDER BY created_at DESC', userId).map(memberAppeal);
    const signals = all<{ kind: string; created_at: string }>('SELECT kind,created_at FROM risk_signals WHERE user_id=? ORDER BY created_at DESC LIMIT 5000', userId);
    return {
      sanctions,
      appeals,
      risk_signals: {
        note: 'Événements de sécurité conservés sous forme d’empreintes à clé (adresse IP, appareil, navigateur) non réversibles.',
        events: signals,
      },
    };
  },
  erase(userId) {
    run('DELETE FROM risk_signals WHERE user_id=?', userId);
    run("DELETE FROM risk_cases WHERE user_id=? AND status='dismissed'", userId);
    run("DELETE FROM risk_case_subjects WHERE user_id=? AND case_id IN (SELECT id FROM risk_cases WHERE status='dismissed')", userId);
  },
});
