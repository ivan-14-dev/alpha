import { Router, type Request } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, notify, now, requireUser } from '../core.js';

const router = Router();
const identifier = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const offsetSchema = z.string().regex(/^\d{1,7}$/).transform(Number).refine((value) => value <= 1_000_000).default('0');
const roleSchema = z.enum(['tester', 'owner']);
const optionalRating = z.number().int().min(1).max(5).nullable().optional();
const pageSize = 24;
const reviewSchema = z.object({
  mission_id: identifier,
  rating: z.number().int().min(1).max(5),
  communication_rating: optionalRating,
  quality_rating: optionalRating,
  body: z.string().trim().min(10).max(2000),
}).strict();

interface PublicUser {
  id: string;
  name: string;
  title: string;
  avatar_color: string;
}

interface ReviewRow {
  id: string;
  subject_id: string;
  rating: number;
  communication_rating: number | null;
  quality_rating: number | null;
  reviewed_role: 'tester' | 'owner';
  body: string;
  created_at: string;
  author_id: string;
  author_name: string;
  author_title: string;
  author_avatar_color: string;
}

// Joins establish the participants and role, never project or report details.
const reviewFrom = `FROM reviews r JOIN missions m ON m.id=r.mission_id
  JOIN campaigns c ON c.id=m.campaign_id`;
const verifiedReview = `m.status='paid' AND m.tester_id<>c.owner_id AND
  ((r.author_id=c.owner_id AND r.subject_id=m.tester_id)
    OR (r.author_id=m.tester_id AND r.subject_id=c.owner_id))`;
const reviewedRole = "CASE WHEN r.subject_id=m.tester_id THEN 'tester' ELSE 'owner' END";
const reviewSelect = `SELECT r.id,r.subject_id,r.rating,r.communication_rating,r.quality_rating,r.body,r.created_at,
  ${reviewedRole} AS reviewed_role,
  u.id AS author_id,u.name AS author_name,u.title AS author_title,u.avatar_color AS author_avatar_color
  ${reviewFrom} JOIN users u ON u.id=r.author_id`;

interface AggregateRow {
  average: number | null;
  count: number;
  communication_average: number | null;
  communication_count: number;
  quality_average: number | null;
  quality_count: number;
  without_criteria_count: number;
}

const aggregateSelect = `AVG(r.rating) AS average,COUNT(*) AS count,
  AVG(r.communication_rating) AS communication_average,COUNT(r.communication_rating) AS communication_count,
  AVG(r.quality_rating) AS quality_average,COUNT(r.quality_rating) AS quality_count,
  COALESCE(SUM(r.communication_rating IS NULL AND r.quality_rating IS NULL),0) AS without_criteria_count`;

function aggregate(row: AggregateRow) {
  return {
    average: row.average,
    count: row.count,
    without_criteria_count: row.without_criteria_count,
    criteria: {
      communication: { average: row.communication_average, count: row.communication_count },
      quality: { average: row.quality_average, count: row.quality_count },
    },
  };
}

function publicReview(row: ReviewRow) {
  return {
    id: row.id,
    subject_id: row.subject_id,
    rating: row.rating,
    communication_rating: row.communication_rating,
    quality_rating: row.quality_rating,
    reviewed_role: row.reviewed_role,
    body: row.body,
    created_at: row.created_at,
    verified: true,
    author: {
      id: row.author_id,
      name: row.author_name,
      title: row.author_title,
      avatar_color: row.author_avatar_color,
    },
  };
}

function recipient(req: Request): PublicUser {
  const rawId = req.query.user ?? req.user?.id;
  if (rawId === undefined) throw new HttpError(400, 'Indiquez le membre dont vous souhaitez consulter les avis.');
  const userId = identifier.parse(rawId);
  const user = one<PublicUser>('SELECT id,name,title,avatar_color FROM users WHERE id=?', userId);
  if (!user) throw new HttpError(404, 'Membre introuvable.');
  return user;
}

function pagination(offset: number, total: number) {
  return { offset, limit: pageSize, total, has_more: offset + pageSize < total };
}

router.get('/reviews', (req, res) => {
  const user = recipient(req);
  const { offset, rating, role } = z.object({
    offset: offsetSchema,
    rating: z.enum(['1', '2', '3', '4', '5']).transform(Number).optional(),
    role: roleSchema.optional(),
  }).parse(req.query);
  const condition = `${verifiedReview} AND r.subject_id=?`
    + (rating === undefined ? '' : ' AND r.rating=?')
    + (role === undefined ? '' : ` AND ${reviewedRole}=?`);
  const params = rating === undefined ? [user.id] : [user.id, rating];
  if (role !== undefined) params.push(role);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total ${reviewFrom} WHERE ${condition}`, ...params)!.total;
  const reviews = all<ReviewRow>(
    `${reviewSelect} WHERE ${condition} ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(publicReview);
  res.json({ user, reviews, pagination: pagination(offset, total) });
});

router.get('/summary', (req, res) => {
  const user = recipient(req);
  const condition = `${verifiedReview} AND r.subject_id=?`;
  const summary = aggregate(one<AggregateRow>(
    `SELECT ${aggregateSelect} ${reviewFrom} WHERE ${condition}`, user.id,
  )!);
  const roles = Object.fromEntries(['tester', 'owner'].map((role) => [role, aggregate(one<AggregateRow>(
    `SELECT ${aggregateSelect} ${reviewFrom} WHERE ${condition} AND ${reviewedRole}=?`, user.id, role,
  )!)]));
  const paidMissions = one<{ tester: number; owner: number; total: number }>(
    `SELECT COALESCE(SUM(m.tester_id=?),0) AS tester,COALESCE(SUM(c.owner_id=?),0) AS owner,COUNT(*) AS total
      FROM missions m JOIN campaigns c ON c.id=m.campaign_id
      WHERE m.status='paid' AND m.tester_id<>c.owner_id AND (m.tester_id=? OR c.owner_id=?)`,
    user.id, user.id, user.id, user.id,
  )!;
  const counts = all<{ rating: number; count: number }>(
    `SELECT r.rating,COUNT(*) AS count ${reviewFrom} WHERE ${condition} GROUP BY r.rating`, user.id,
  );
  const distribution = [5, 4, 3, 2, 1].map((rating) => ({
    rating,
    count: counts.find((entry) => entry.rating === rating)?.count ?? 0,
  }));
  const milestones = [
    { id: 'first_paid_collaboration', label: 'Première collaboration payée en démo', threshold: 1 },
    { id: 'five_paid_missions', label: '5 missions payées en démo', threshold: 5 },
  ].map((milestone) => ({ ...milestone, count: paidMissions.total, earned: paidMissions.total >= milestone.threshold }));
  res.json({ user, summary: { ...summary, distribution, roles, paid_missions: paidMissions, milestones, payment_mode: 'demo' } });
});

router.get('/history', (req, res) => {
  const user = recipient(req);
  const { offset, role } = z.object({ offset: offsetSchema, role: roleSchema.optional() }).parse(req.query);
  const actorRole = "CASE WHEN m.tester_id=? THEN 'tester' ELSE 'owner' END";
  const from = `FROM missions m JOIN campaigns c ON c.id=m.campaign_id JOIN projects p ON p.id=c.project_id`;
  // Apply current visibility to both the rows and total, even for authenticated participants.
  const condition = `m.status='paid' AND m.tester_id<>c.owner_id AND p.visibility='public'
    AND (m.tester_id=? OR c.owner_id=?)` + (role === undefined ? '' : ` AND ${actorRole}=?`);
  const params = role === undefined ? [user.id, user.id] : [user.id, user.id, user.id, role];
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total ${from} WHERE ${condition}`, ...params)!.total;
  const history = all<{ project_id: string; project_title: string; role: 'tester' | 'owner'; completed_at: string }>(
    `SELECT p.id AS project_id,p.title AS project_title,${actorRole} AS role,
      COALESCE((SELECT t.created_at FROM transactions t WHERE t.mission_id=m.id
        AND t.kind='payout' AND t.status='completed'),m.updated_at) AS completed_at
      ${from} WHERE ${condition} ORDER BY completed_at DESC,m.id DESC LIMIT ? OFFSET ?`,
    user.id, ...params, pageSize, offset,
  );
  res.json({ user, history, pagination: pagination(offset, total) });
});

router.get('/eligible', (req, res) => {
  const user = requireUser(req);
  const offset = offsetSchema.parse(req.query.offset);
  const condition = `m.status='paid' AND (m.tester_id=? OR c.owner_id=?)
    AND m.tester_id<>c.owner_id
    AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.author_id=? AND r.mission_id=m.id)`;
  const params = [user.id, user.id, user.id];
  const total = one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE ${condition}`,
    ...params,
  )!.total;
  const rows = all<{
    id: string; created_at: string; tester_id: string;
    subject_id: string; subject_name: string; subject_title: string; subject_avatar_color: string;
  }>(`SELECT m.id,m.created_at,m.tester_id,
      u.id AS subject_id,u.name AS subject_name,u.title AS subject_title,u.avatar_color AS subject_avatar_color
    FROM missions m JOIN campaigns c ON c.id=m.campaign_id
    JOIN users u ON u.id=CASE WHEN m.tester_id=? THEN c.owner_id ELSE m.tester_id END
    WHERE ${condition} ORDER BY m.updated_at DESC,m.id DESC LIMIT ? OFFSET ?`,
  user.id, ...params, pageSize, offset);
  const missions = rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    reviewer_role: row.tester_id === user.id ? 'tester' : 'owner',
    subject: {
      id: row.subject_id,
      name: row.subject_name,
      title: row.subject_title,
      avatar_color: row.subject_avatar_color,
    },
  }));
  res.json({ missions, pagination: pagination(offset, total) });
});

router.post('/reviews', (req, res) => {
  const user = requireUser(req);
  const input = reviewSchema.parse(req.body);
  const review = transaction(() => {
    const mission = one<{ status: string; tester_id: string; owner_id: string }>(
      'SELECT m.status,m.tester_id,c.owner_id FROM missions m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?',
      input.mission_id,
    );
    if (!mission) throw new HttpError(404, 'Mission introuvable.');
    if (mission.tester_id !== user.id && mission.owner_id !== user.id) {
      throw new HttpError(403, 'Seuls les deux participants de cette mission peuvent laisser un avis.');
    }
    const subjectId = mission.tester_id === user.id ? mission.owner_id : mission.tester_id;
    if (subjectId === user.id) throw new HttpError(403, 'Vous ne pouvez pas vous évaluer vous-même.');
    if (mission.status !== 'paid') {
      throw new HttpError(409, 'Un avis est possible uniquement après le versement de démonstration de la mission.');
    }
    if (one('SELECT id FROM reviews WHERE author_id=? AND mission_id=?', user.id, input.mission_id)) {
      throw new HttpError(409, 'Vous avez déjà laissé un avis pour cette mission.');
    }
    const reviewId = id();
    run(`INSERT INTO reviews (id,author_id,subject_id,mission_id,rating,communication_rating,quality_rating,body,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    reviewId, user.id, subjectId, input.mission_id, input.rating, input.communication_rating ?? null, input.quality_rating ?? null, input.body, now());
    notify(subjectId, 'review', 'Un nouvel avis sur votre collaboration',
      'Un participant a partagé son expérience de collaboration avec vous.',
      `/reputation?user=${encodeURIComponent(subjectId)}`);
    audit(user.id, 'review.created', 'review', reviewId);
    return publicReview(one<ReviewRow>(`${reviewSelect} WHERE r.id=?`, reviewId)!);
  });
  res.status(201).json({ review });
});

export default router;
