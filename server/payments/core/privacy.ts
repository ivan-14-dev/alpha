import { all, run } from '../../db.js';
import { registerPersonalData } from '../../platform/privacy.js';
import { publicIntent, type IntentRow } from './store.js';

/**
 * GDPR: payment intents and refunds are financial records (kept, legal retention); only contact data
 * (masked phone, provider instructions, redirect URLs) and free-text reasons are scrubbed on erasure.
 */
registerPersonalData('payments', {
  description: 'Paiements en bac à sable / réels (intentions de paiement, remboursements) ; les écritures comptables sont conservées.',
  export(userId) {
    const intents = all<IntentRow>('SELECT * FROM payment_intents WHERE user_id=? ORDER BY created_at', userId).map(publicIntent);
    const refunds = all<{ id: string; intent_id: string; amount_minor: number; currency: string; status: string; reason: string; created_at: string }>(
      `SELECT r.id,r.intent_id,r.amount_minor,r.currency,r.status,r.reason,r.created_at FROM refunds r
       JOIN payment_intents i ON i.id=r.intent_id WHERE i.user_id=? ORDER BY r.created_at`, userId);
    return { intents, refunds };
  },
  erase(userId) {
    run(`UPDATE payment_intents SET customer_phone_masked='',instructions='',operator=NULL,redirect_url=NULL WHERE user_id=?`, userId);
    run(`UPDATE refunds SET reason='[supprimé]' WHERE intent_id IN (SELECT id FROM payment_intents WHERE user_id=?)`, userId);
  },
});
