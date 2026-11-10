import { Router } from 'express';
import { z } from 'zod';
import { all } from '../db.js';
import { now, requireUser } from '../core.js';
import { rateLimit } from '../platform/rateLimit.js';
import { appealBlocker, appealDeadline, createAppeal, memberAppeal, myAppeals, type AppealRow } from './appeals.js';
import { publicSanction, type SanctionRow } from './sanctions.js';
import { appealSettings, DAY_MS, MAX_APPEALS_PER_SANCTION } from './settings.js';

/** Member self-service (always reachable, even while suspended): statements of reasons and appeals. */
const router = Router();
const identifier = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const appealInput = z.object({
  sanction_id: identifier,
  statement: z.string().trim().min(30, 'Expliquez votre contestation en au moins 30 caractères.').max(3000),
}).strict();

const REDRESS = 'Chaque appel est examiné par une personne de l’équipe de modération, différente de l’automatisme qui a pu signaler votre compte. '
  + 'Si la décision est maintenue, vous pouvez saisir un organe de règlement extrajudiciaire des litiges certifié (DSA, art. 21) ou les juridictions compétentes.';

router.get('/me/restrictions', (req, res) => {
  const user = requireUser(req);
  const at = now();
  const sanctions = all<SanctionRow>('SELECT * FROM sanctions WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id);
  const appeals = all<AppealRow>('SELECT * FROM appeals WHERE user_id=? ORDER BY created_at DESC LIMIT 300', user.id);
  const items = sanctions.map((row) => {
    const own = appeals.filter((appeal) => appeal.sanction_id === row.id);
    const blocker = appealBlocker(row, own, at);
    return {
      ...publicSanction(row, at),
      appeals: own.map(memberAppeal),
      appeal_deadline: row.appealable ? appealDeadline(row) : null,
      can_appeal: !blocker,
      appeal_blocker: blocker,
    };
  });
  const settings = appealSettings();
  res.json({
    active: items.filter((item) => item.active),
    history: items.filter((item) => !item.active),
    appeal_sla_days: settings.sla_days,
    max_appeals: MAX_APPEALS_PER_SANCTION,
    redress: REDRESS,
  });
});

router.get('/appeals', (req, res) => {
  const user = requireUser(req);
  res.json({ appeals: myAppeals(user.id) });
});

router.post('/appeals', (req, _res, next) => { requireUser(req); next(); }, rateLimit({
  name: 'trust.appeal', limit: 10, windowMs: DAY_MS, key: (req) => req.user!.id,
  message: 'Trop d’appels envoyés en 24 heures. Réessayez plus tard.',
}), (req, res) => {
  const user = requireUser(req);
  const input = appealInput.parse(req.body);
  res.status(201).json({ appeal: createAppeal(user, input.sanction_id, input.statement) });
});

export default router;
