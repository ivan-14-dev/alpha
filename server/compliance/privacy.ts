import { registerPersonalData } from '../platform/privacy.js';
import { eraseKyc, exportKyc } from './kyc.js';
import { erasePayoutMethods, exportPayoutMethods } from './payoutMethods.js';
import { exportWithdrawals } from './withdrawals.js';
import { exportInvoices } from './invoices.js';

/**
 * GDPR handler. Erasure scrubs identity data (KYC fields, sealed address, document references) and payout
 * coordinates, but KEEPS withdrawals and invoices: accounting documents must be retained for 10 years
 * (French Code de commerce, art. L123-22; livre des procédures fiscales, art. L102 B) and AML records for 5 years.
 * KYC document files themselves are handled by the files module retention policy.
 */
registerPersonalData('compliance', {
  description: 'Vérification d’identité (sans le contenu des pièces), moyens de versement masqués, retraits et documents comptables (reçus, factures, relevés).',
  export: (userId) => ({
    kyc: exportKyc(userId),
    payout_methods: exportPayoutMethods(userId),
    withdrawals: exportWithdrawals(userId),
    invoices: exportInvoices(userId),
    retention: 'Les retraits et documents comptables sont conservés 10 ans (obligation légale de conservation comptable), même après suppression du compte.',
  }),
  erase: (userId) => {
    eraseKyc(userId);
    erasePayoutMethods(userId);
  },
});
