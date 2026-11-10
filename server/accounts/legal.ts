import { Router } from 'express';
import { z } from 'zod';
import { transaction } from '../db.js';
import { audit, requireUser } from '../core.js';
import { hasAcceptedCurrent, legalDocuments, pendingRequiredDocuments, recordLegalAcceptance, type LegalDocument } from '../platform/legal.js';
import { requireLiveSession } from './session.js';

const documentKeys = Object.keys(legalDocuments) as [LegalDocument, ...LegalDocument[]];
const acceptInput = z.object({ documents: z.array(z.enum(documentKeys)).min(1).max(documentKeys.length) }).strict();

function legalStatus(userId: string) {
  return {
    pending: pendingRequiredDocuments(userId),
    documents: documentKeys.map((key) => ({
      key,
      title: legalDocuments[key].title,
      version: legalDocuments[key].version,
      required: legalDocuments[key].required,
      accepted: hasAcceptedCurrent(userId, key),
    })),
  };
}

export const legalRouter = Router();

legalRouter.get('/', (req, res) => {
  const user = requireUser(req);
  res.json(legalStatus(user.id));
});

legalRouter.post('/accept', (req, res) => {
  requireUser(req);
  const { documents } = acceptInput.parse(req.body);
  const unique = [...new Set(documents)];
  const status = transaction(() => {
    const { user } = requireLiveSession(req);
    const fresh = unique.filter((document) => !hasAcceptedCurrent(user.id, document));
    recordLegalAcceptance(user.id, unique);
    if (fresh.length) {
      audit(user.id, 'auth.legal_accepted', 'user', user.id,
        JSON.stringify(Object.fromEntries(fresh.map((document) => [document, legalDocuments[document].version]))));
    }
    return legalStatus(user.id);
  });
  res.json(status);
});
