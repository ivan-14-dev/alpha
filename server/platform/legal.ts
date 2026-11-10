import { all, run } from '../db.js';
import { id } from '../core.js';

/**
 * Versioned legal documents. Bumping a version requires users to accept again (enforced by the privacy module).
 * Texts live in src/pages/LegalPage.tsx and are TEMPLATES that must be validated by a lawyer before launch.
 */
export const legalDocuments = {
  terms: { version: '2026-11-v4', title: 'Conditions générales d’utilisation', required: true },
  privacy: { version: '2026-11-v4', title: 'Politique de confidentialité', required: true },
  payments: { version: '2026-11-v4', title: 'Conditions des paiements, séquestre et retraits', required: false },
  tester_charter: { version: '2026-11-v4', title: 'Charte des testeurs', required: false },
  seller_terms: { version: '2026-11-v4', title: 'Conditions vendeurs de la marketplace', required: false },
} as const;
export type LegalDocument = keyof typeof legalDocuments;

/** Records acceptance of the CURRENT version of each document. Call inside the caller's transaction. */
export function recordLegalAcceptance(userId: string, documents: LegalDocument[]) {
  for (const document of documents) {
    run('INSERT OR IGNORE INTO legal_acceptances(id,user_id,document,version) VALUES (?,?,?,?)',
      id(), userId, document, legalDocuments[document].version);
  }
}

export function hasAcceptedCurrent(userId: string, document: LegalDocument): boolean {
  return all('SELECT 1 FROM legal_acceptances WHERE user_id=? AND document=? AND version=?',
    userId, document, legalDocuments[document].version).length > 0;
}

export function pendingRequiredDocuments(userId: string): LegalDocument[] {
  return (Object.keys(legalDocuments) as LegalDocument[])
    .filter((document) => legalDocuments[document].required && !hasAcceptedCurrent(userId, document));
}
