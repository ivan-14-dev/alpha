import { all, one, run } from '../db.js';
import { registerJob } from '../platform/jobs.js';
import { registerPersonalData } from '../platform/privacy.js';
import { accountFlags, linkedIdentities, mfaStatus } from './status.js';

registerPersonalData('accounts', {
  description: 'Sécurité du compte : vérification de l’e-mail, double authentification (sans secret), comptes GitHub/Google associés et acceptations des documents légaux.',
  export(userId) {
    const flags = accountFlags(userId);
    return {
      email_verified_at: flags.email_verified_at,
      has_password: flags.has_password,
      mfa: mfaStatus(userId),
      oauth_identities: linkedIdentities(userId),
      legal_acceptances: all('SELECT document,version,accepted_at FROM legal_acceptances WHERE user_id=? ORDER BY accepted_at', userId),
      pending_links: {
        email_verification: one<{ count: number }>('SELECT COUNT(*) AS count FROM email_verification_tokens WHERE user_id=? AND used_at IS NULL', userId)!.count,
        password_reset: one<{ count: number }>('SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL', userId)!.count,
      },
    };
  },
  erase(userId) {
    // Legal acceptances are kept as proof of consent; they only reference the anonymized user id.
    for (const table of ['email_verification_tokens', 'password_reset_tokens', 'mfa_recovery_codes', 'mfa_totp', 'mfa_challenges', 'oauth_identities', 'oauth_states']) {
      run(`DELETE FROM ${table} WHERE user_id=?`, userId);
    }
  },
});

registerJob({
  name: 'accounts.purge',
  description: 'Supprime les liens de vérification/réinitialisation, défis MFA et états OAuth expirés ou utilisés.',
  intervalMs: 60 * 60000,
  run: () => {
    const current = new Date().toISOString();
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    run('DELETE FROM email_verification_tokens WHERE expires_at<=? OR (used_at IS NOT NULL AND used_at<=?)', current, dayAgo);
    run('DELETE FROM password_reset_tokens WHERE expires_at<=? OR (used_at IS NOT NULL AND used_at<=?)', current, dayAgo);
    run('DELETE FROM mfa_challenges WHERE expires_at<=? OR used_at IS NOT NULL', current);
    run('DELETE FROM oauth_states WHERE expires_at<=?', current);
  },
});
