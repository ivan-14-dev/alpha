import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

process.env.DATABASE_PATH = ':memory:';
const { attachUser, authRouter } = await import('../server/auth.js');
const { errorHandler } = await import('../server/core.js');
const { db, one, run } = await import('../server/db.js');
const { default: reputation } = await import('../server/modules/reputation.js');

interface Actor { id: string; cookie: string }
interface Evidence { average: number | null; count: number }
interface Aggregate extends Evidence {
  without_criteria_count: number;
  criteria: { communication: Evidence; quality: Evidence };
}
interface Summary extends Aggregate {
  distribution: { rating: number; count: number }[];
  roles: { tester: Aggregate; owner: Aggregate };
  paid_missions: { tester: number; owner: number; total: number };
  milestones: { id: string; label: string; threshold: number; count: number; earned: boolean }[];
  payment_mode: string;
}
interface Review {
  id: string; subject_id: string; reviewed_role: 'tester' | 'owner'; rating: number;
  communication_rating: number | null; quality_rating: number | null; verified: boolean;
}
interface Pagination { offset: number; limit: number; total: number; has_more: boolean }
interface HistoryEntry { project_id: string; project_title: string; role: 'tester' | 'owner'; completed_at: string }
interface History { history: HistoryEntry[]; pagination: Pagination }
interface Reviews { reviews: Review[]; pagination: Pagination }

function assertPrivate(value: unknown, forbiddenValues: string[] = []) {
  const text = JSON.stringify(value);
  for (const field of ['mission_id', 'campaign_id', 'application_id', 'email', 'password_hash', 'token_hash', 'report', 'reward_cents', 'amount_cents', 'organization_id', 'members']) {
    assert.ok(!text.includes(`"${field}"`), `Unexpected private field: ${field}`);
  }
  for (const forbidden of forbiddenValues) assert.ok(!text.includes(forbidden), `Private value leaked: ${forbidden}`);
}

test('richer reputation preserves paid evidence, legacy reviews, participant roles and current project privacy', async (t) => {
  const app = express();
  app.use(express.json(), attachUser);
  app.use('/api/auth', authRouter);
  app.use('/api/reputation', reputation);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function api<T>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Alpha-Client': 'web',
        ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T;
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    if (expected >= 400) assert.equal(typeof (data as { error: unknown }).error, 'string');
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) actor.cookie = cookie.split(';', 1)[0];
    return data;
  }
  async function account(name: string) {
    const actor = { id: '', cookie: '' };
    const { user } = await api<{ user: { id: string } }>(actor, '/auth/register', 201, 'POST', {
      name, email: `${name}@example.test`, password: 'Reputation-test-password-2026!',
    });
    actor.id = user.id;
    return actor;
  }
  const owner = await account('CampaignOwner');
  const member = await account('ReviewedMember');
  const outsider = await account('ProjectOwner');
  const observer = await account('Observer');
  function project(title: string, visibility = 'public') {
    const id = randomUUID();
    run('INSERT INTO projects(id,owner_id,title,summary,category,visibility) VALUES (?,?,?,?,?,?)',
      id, outsider.id, title, 'Project summary', 'software', visibility);
    return id;
  }
  const publicId = project('Public collaboration');
  const privateTitle = 'PRIVATE-PROJECT-TITLE-NEVER-EXPOSE';
  const privateId = project(privateTitle, 'private');
  function mission(projectId: string, campaignOwner: Actor, tester: Actor, status = 'paid', completedAt = '2026-03-03T12:00:00.000Z') {
    const campaignId = randomUUID();
    const applicationId = randomUUID();
    const missionId = randomUUID();
    run(`INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline)
      VALUES (?,?,?,?,?,1000,1,?)`, campaignId, projectId, campaignOwner.id, 'PRIVATE-CAMPAIGN-TITLE', 'Private scope', '2026-01-01T00:00:00.000Z');
    run('INSERT INTO applications(id,campaign_id,tester_id,motivation,status) VALUES (?,?,?,?,?)',
      applicationId, campaignId, tester.id, 'PRIVATE-MOTIVATION', 'accepted');
    run('INSERT INTO missions(id,campaign_id,tester_id,application_id,status,updated_at) VALUES (?,?,?,?,?,?)',
      missionId, campaignId, tester.id, applicationId, status, completedAt);
    return missionId;
  }
  function legacy(missionId: string, author: Actor, subject: Actor, rating = 5) {
    const id = randomUUID();
    run('INSERT INTO reviews(id,author_id,subject_id,mission_id,rating,body,created_at) VALUES (?,?,?,?,?,?,?)',
      id, author.id, subject.id, missionId, rating, 'A genuine collaboration opinion.', '2026-03-04T12:00:00.000Z');
    return id;
  }
  const summary = async (actor = member) => (await api<{ summary: Summary }>(null, `/reputation/summary?user=${actor.id}`)).summary;
  const reviewBody = (missionId: string, extra = {}) => ({ mission_id: missionId, rating: 5, body: 'A subjective and constructive collaboration review.', ...extra });
  let firstMission = '';
  let privateMission = '';
  let fifthMission = '';

  await t.test('empty evidence has null means, zero samples and explicit unearned thresholds', async () => {
    const empty = await summary();
    assert.equal(empty.average, null);
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.criteria, { communication: { average: null, count: 0 }, quality: { average: null, count: 0 } });
    assert.deepEqual(empty.paid_missions, { tester: 0, owner: 0, total: 0 });
    assert.deepEqual(empty.roles.tester, empty.roles.owner);
    assert.equal(empty.roles.owner.average, null);
    assert.equal(empty.without_criteria_count, 0);
    assert.deepEqual(empty.milestones.map(({ threshold, count, earned }) => ({ threshold, count, earned })), [
      { threshold: 1, count: 0, earned: false }, { threshold: 5, count: 0, earned: false },
    ]);
    assert.equal(empty.payment_mode, 'demo');
  });

  await t.test('legacy rows and old V1 POST bodies retain null dimensions and server-derived roles', async () => {
    firstMission = mission(publicId, owner, member);
    const legacyId = legacy(firstMission, owner, member);
    const stored = one<{ communication_rating: number | null; quality_rating: number | null }>(
      'SELECT communication_rating,quality_rating FROM reviews WHERE id=?', legacyId)!;
    assert.equal(stored.communication_rating, null);
    assert.equal(stored.quality_rating, null);
    const first = await summary();
    assert.equal(first.average, 5);
    assert.equal(first.criteria.communication.count, 0);
    assert.equal(first.without_criteria_count, 1);
    assert.deepEqual(first.milestones.map((entry) => entry.earned), [true, false]);
    const secondMission = mission(publicId, owner, member);
    const { review } = await api<{ review: Review }>(owner, '/reputation/reviews', 201, 'POST', reviewBody(secondMission, { rating: 3 }));
    assert.equal(review.reviewed_role, 'tester');
    assert.equal(review.subject_id, member.id);
    assert.equal(review.communication_rating, null);
    assert.equal(review.quality_rating, null);
    assert.equal(review.verified, true);
    assertPrivate(review, [secondMission, publicId, privateId, privateTitle]);
    const reverse = await api<{ review: Review }>(member, '/reputation/reviews', 201, 'POST', reviewBody(firstMission, { rating: 4, communication_rating: null }));
    assert.equal(reverse.review.subject_id, owner.id);
    assert.equal(reverse.review.reviewed_role, 'owner');
    assert.equal(reverse.review.communication_rating, null);
    assert.equal((await summary(owner)).roles.owner.count, 1);
    await api(owner, '/reputation/reviews', 409, 'POST', reviewBody(secondMission));
    const eligible = await api<{ missions: { id: string }[] }>(owner, '/reputation/eligible');
    assert.ok(!eligible.missions.some((entry) => entry.id === secondMission || entry.id === firstMission));
  });

  await t.test('partial criteria use their own samples; mixed-role aggregates and milestone boundaries are deterministic', async () => {
    privateMission = mission(privateId, owner, member);
    await api(owner, '/reputation/reviews', 201, 'POST', reviewBody(privateMission, { rating: 4, communication_rating: 2 }));
    run('INSERT INTO test_reports(id,mission_id,summary,steps,expected,observed) VALUES (?,?,?,?,?,?)',
      randomUUID(), privateMission, 'PRIVATE-REPORT-SUMMARY', 'PRIVATE-STEPS', 'PRIVATE-EXPECTED', 'PRIVATE-OBSERVED');
    const creatorMission = mission(publicId, member, observer);
    const creatorReview = await api<{ review: Review }>(observer, '/reputation/reviews', 201, 'POST',
      reviewBody(creatorMission, { rating: 2, quality_rating: 5 }));
    assert.equal(creatorReview.review.reviewed_role, 'owner');
    assert.equal(creatorReview.review.subject_id, member.id);
    assert.deepEqual((await summary()).milestones.map(({ count, earned }) => ({ count, earned })), [
      { count: 4, earned: true }, { count: 4, earned: false },
    ]);
    fifthMission = mission(publicId, owner, member);
    await api(owner, '/reputation/reviews', 201, 'POST', reviewBody(fifthMission, { rating: 1, communication_rating: 4, quality_rating: 3 }));
    const result = await summary();
    assert.equal(result.average, 3);
    assert.equal(result.count, 5);
    assert.equal(result.without_criteria_count, 2);
    assert.deepEqual(result.criteria, { communication: { average: 3, count: 2 }, quality: { average: 4, count: 2 } });
    assert.deepEqual(result.distribution, [5, 4, 3, 2, 1].map((rating) => ({ rating, count: 1 })));
    assert.deepEqual(result.paid_missions, { tester: 4, owner: 1, total: 5 });
    assert.deepEqual(result.roles.tester, {
      average: 3.25, count: 4, without_criteria_count: 2,
      criteria: { communication: { average: 3, count: 2 }, quality: { average: 3, count: 1 } },
    });
    assert.deepEqual(result.roles.owner, {
      average: 2, count: 1, without_criteria_count: 0,
      criteria: { communication: { average: null, count: 0 }, quality: { average: 5, count: 1 } },
    });
    assert.deepEqual(result.milestones.map(({ count, earned }) => ({ count, earned })), [
      { count: 5, earned: true }, { count: 5, earned: true },
    ]);
    assert.deepEqual(await summary(), result);
    assertPrivate(result, [firstMission, privateMission, privateId, publicId, privateTitle, 'PRIVATE-REPORT-SUMMARY']);
    const filtered = await api<Reviews>(null, `/reputation/reviews?user=${member.id}&role=owner&rating=2`);
    assert.equal(filtered.pagination.total, 1);
    assert.equal(filtered.reviews[0].reviewed_role, 'owner');
    assert.equal(filtered.reviews[0].quality_rating, 5);
    const testers = await api<Reviews>(null, `/reputation/reviews?user=${member.id}&role=tester`);
    assert.equal(testers.pagination.total, 4);
    assert.ok(testers.reviews.every((review) => review.reviewed_role === 'tester'));
    assert.ok(testers.reviews.some((review) => review.communication_rating === null && review.quality_rating === null));
  });

  await t.test('authentication, self-reviews, wrong actors, spoofed roles and invalid dimensions are rejected', async () => {
    await api(null, '/reputation/reviews', 401, 'POST', reviewBody(firstMission));
    await api(null, '/reputation/eligible', 401);
    await api(outsider, '/reputation/reviews', 403, 'POST', reviewBody(firstMission));
    await api(observer, '/reputation/reviews', 403, 'POST', reviewBody(firstMission));
    const selfMission = mission(publicId, member, member);
    await api(member, '/reputation/reviews', 403, 'POST', reviewBody(selfMission));
    const eligible = await api<{ missions: { id: string }[] }>(member, '/reputation/eligible');
    assert.ok(!eligible.missions.some((entry) => entry.id === selfMission));
    for (const field of ['subject_id', 'reviewed_role', 'role', 'author_id']) {
      await api(owner, '/reputation/reviews', 400, 'POST', reviewBody(firstMission, { [field]: 'owner' }));
    }
    for (const field of ['communication_rating', 'quality_rating']) {
      for (const value of [0, 6, 2.5, '5', true, {}, []]) {
        await api(owner, '/reputation/reviews', 400, 'POST', reviewBody(firstMission, { [field]: value }));
      }
    }
    for (const endpoint of ['reviews', 'summary', 'history']) {
      await api(null, `/reputation/${endpoint}`, 400);
      await api(null, `/reputation/${endpoint}?user=unknown-member`, 404);
      await api(null, `/reputation/${endpoint}?user[]=invalid`, 400);
    }
    for (const endpoint of ['reviews', 'history']) {
      await api(null, `/reputation/${endpoint}?user=${member.id}&role=creator`, 400);
      for (const offset of ['-1', '1.5', '1000001', 'not-a-number']) {
        await api(null, `/reputation/${endpoint}?user=${member.id}&offset=${offset}`, 400);
      }
    }
    assert.deepEqual((await summary()).paid_missions, { tester: 4, owner: 1, total: 5 });
  });

  await t.test('unpaid statuses and invalid legacy participants cannot contribute verified evidence', async () => {
    const before = await summary();
    for (const status of ['assigned', 'in_progress', 'submitted', 'changes_requested', 'accepted', 'disputed', 'cancelled']) {
      const unpaid = mission(publicId, owner, member, status);
      await api(owner, '/reputation/reviews', 409, 'POST', reviewBody(unpaid));
      legacy(unpaid, owner, member);
    }
    legacy(fifthMission, outsider, member);
    legacy(fifthMission, member, member);
    const after = await summary();
    assert.deepEqual(after, before);
    const reviews = await api<Reviews>(null, `/reputation/reviews?user=${member.id}`);
    assert.equal(reviews.pagination.total, 5);
    assert.equal(reviews.reviews.length, 5);
    assertPrivate(reviews, [privateId, privateTitle, privateMission, 'PRIVATE-REPORT-SUMMARY']);
  });

  await t.test('public history uses payment completion, excludes private missions from rows and totals, and revokes links on visibility changes', async () => {
    const paidAt = '2026-03-01T09:30:00.000Z';
    run(`INSERT INTO transactions(id,user_id,mission_id,kind,amount_cents,created_at)
      VALUES (?,?,?,'payout',1000,?)`, randomUUID(), member.id, firstMission, paidAt);
    const publicHistory = await api<History>(null, `/reputation/history?user=${member.id}`);
    assert.equal(publicHistory.pagination.total, 4);
    assert.equal(publicHistory.history.length, 4);
    assert.ok(publicHistory.history.some((entry) => entry.completed_at === paidAt));
    assert.equal(publicHistory.history.filter((entry) => entry.role === 'owner').length, 1);
    for (const entry of publicHistory.history) {
      assert.deepEqual(Object.keys(entry).sort(), ['completed_at', 'project_id', 'project_title', 'role']);
      assert.equal(entry.project_id, publicId);
      assert.equal(entry.project_title, 'Public collaboration');
    }
    assertPrivate(publicHistory, [privateId, privateTitle, privateMission, firstMission, 'PRIVATE-REPORT-SUMMARY']);
    const filtered = await api<History>(null, `/reputation/history?user=${member.id}&role=owner`);
    assert.equal(filtered.pagination.total, 1);
    const before = await summary();
    run("UPDATE projects SET visibility='private' WHERE id=?", publicId);
    for (const actor of [null, member, owner, outsider]) {
      const hidden = await api<History>(actor, `/reputation/history?user=${member.id}`);
      assert.deepEqual(hidden.history, []);
      assert.deepEqual(hidden.pagination, { offset: 0, limit: 24, total: 0, has_more: false });
      assertPrivate(hidden, [publicId, 'Public collaboration', privateId, privateTitle]);
    }
    const beyond = await api<History>(null, `/reputation/history?user=${member.id}&offset=24&role=tester`);
    assert.equal(beyond.pagination.total, 0);
    assert.deepEqual(beyond.history, []);
    assert.deepEqual(await summary(), before);
    assert.equal((await api<Reviews>(null, `/reputation/reviews?user=${member.id}`)).pagination.total, 5);
    run("UPDATE projects SET visibility='public' WHERE id=?", publicId);
    assert.equal((await api<History>(null, `/reputation/history?user=${member.id}`)).pagination.total, 4);
  });

  await t.test('reviews and public history paginate deterministically without counting hidden projects', async () => {
    const pageMember = await account('PaginationMember');
    const projectIds: string[] = [];
    for (let index = 0; index < 26; index++) {
      const projectId = project(`Pagination public project ${index}`);
      projectIds.push(projectId);
      const missionId = mission(projectId, owner, pageMember);
      legacy(missionId, owner, pageMember);
    }
    mission(privateId, owner, pageMember);
    const first = await api<History>(null, `/reputation/history?user=${pageMember.id}`);
    const second = await api<History>(null, `/reputation/history?user=${pageMember.id}&offset=24`);
    assert.deepEqual(first.pagination, { offset: 0, limit: 24, total: 26, has_more: true });
    assert.deepEqual(second.pagination, { offset: 24, limit: 24, total: 26, has_more: false });
    assert.equal(first.history.length, 24);
    assert.equal(second.history.length, 2);
    assert.equal(new Set([...first.history, ...second.history].map((entry) => entry.project_id)).size, 26);
    assert.deepEqual(await api<History>(null, `/reputation/history?user=${pageMember.id}`), first);
    const firstReviews = await api<Reviews>(null, `/reputation/reviews?user=${pageMember.id}`);
    const secondReviews = await api<Reviews>(null, `/reputation/reviews?user=${pageMember.id}&offset=24`);
    assert.equal(firstReviews.reviews.length, 24);
    assert.equal(secondReviews.reviews.length, 2);
    assert.equal(new Set([...firstReviews.reviews, ...secondReviews.reviews].map((entry) => entry.id)).size, 26);
    assert.deepEqual(await api<Reviews>(null, `/reputation/reviews?user=${pageMember.id}`), firstReviews);
    run("UPDATE projects SET visibility='private' WHERE id=?", projectIds[0]);
    const changed = await api<History>(null, `/reputation/history?user=${pageMember.id}`);
    assert.equal(changed.pagination.total, 25);
    assert.ok(!changed.history.some((entry) => entry.project_id === projectIds[0]));
    assert.equal((await summary(pageMember)).paid_missions.total, 27);
    assert.equal((await summary(pageMember)).count, 26);
  });
});
