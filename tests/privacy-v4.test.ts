import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { all, one, run } = await import('../server/db.js');
const { id } = await import('../server/core.js');
const { runJob } = await import('../server/platform/jobs.js');
const { legalDocuments } = await import('../server/platform/legal.js');
const { registerPersonalData } = await import('../server/platform/privacy.js');
const { ledgerAccounts, postJournal } = await import('../server/payments/ledger.js');
const { hasConsent } = await import('../server/privacy/consents.js');
const { anonymizeUser, erasedEmail, erasureBlockers, ERASED_NAME, ERASED_PASSWORD_HASH, executeErasure, SCRUBBED } = await import('../server/privacy/erasure.js');
const { parseMarkdown, safeHref } = await import('../server/privacy/markdown.js');
const { foreignKeyViolations } = await import('../server/privacy/schema.js');

const password = 'Privacy-v4-password-2026!';
type Json = Record<string, any>;
interface Actor { id: string; name: string; email: string; jar: Map<string, string> }

// A module handler registered like other modules do: its data must be exported (without secrets) and erased.
const fixtureErased: string[] = [];
registerPersonalData('privacy-fixture', {
  description: 'Module de test : données fictives.',
  export: (userId) => ({ marker: `fixture-${userId}`, api_token: 'fixture-token-must-not-leak', nested: { client_secret: 'fixture-secret-must-not-leak', note: 'kept' } }),
  erase: (userId) => { fixtureErased.push(userId); },
});

const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();

/** Walks a markdown AST and returns every inline node. */
function inlineNodes(blocks: Json[]): Json[] {
  const nodes: Json[] = [];
  const visit = (inline: Json[]) => {
    for (const node of inline) {
      nodes.push(node);
      if (Array.isArray(node.children)) visit(node.children);
    }
  };
  for (const block of blocks) {
    if (block.children) visit(block.children);
    if (block.items) for (const item of block.items) visit(item);
    if (block.paragraphs) for (const paragraph of block.paragraphs) visit(paragraph);
    if (block.header) for (const cell of block.header) visit(cell);
    if (block.rows) for (const row of block.rows) for (const cell of row) visit(cell);
  }
  return nodes;
}

test('V4 privacy: exports, erasure, consents, retention, legal documents and admin console', { timeout: 180000 }, async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  });

  const actor = (name: string): Actor => ({ id: '', name, email: `${name.toLowerCase()}@privacy.test`, jar: new Map() });
  async function call<T = Json>(who: Actor | null, path: string, options: { method?: string; body?: unknown; expected?: number } = {}) {
    const method = options.method ?? 'GET';
    const expected = options.expected ?? 200;
    const headers = new Headers({ 'X-Alpha-Client': 'web', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) });
    if (who?.jar.size) headers.set('Cookie', [...who.jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(`${base}${path}`, { method, headers, redirect: 'manual', ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    if (who) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        const value = pair.slice(index + 1);
        if (!value || /Max-Age=0(;|$)/.test(cookie)) who.jar.delete(pair.slice(0, index)); else who.jar.set(pair.slice(0, index), value);
      }
    }
    if (expected >= 400 && text) assert.equal(typeof JSON.parse(text).error, 'string', `${method} ${path} must return a JSON error`);
    const data = (text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {}) as T;
    return { data, response, text };
  }
  async function register(who: Actor) {
    const result = await call<{ user: { id: string } }>(who, '/auth/register', { method: 'POST', expected: 201, body: { name: who.name, email: who.email, password, accept_terms: true } });
    who.id = result.data.user.id;
  }
  const resetLimits = () => run('DELETE FROM rate_limit_buckets');
  const outbox = (email: string, category: string) => all<{ subject: string }>('SELECT subject FROM email_outbox WHERE to_address=? AND category=?', email, category);

  const alice = actor('Alice');
  const bob = actor('Bob');
  const admin = actor('Admin');
  const dave = actor('Dave');
  for (const who of [alice, bob, admin, dave]) await register(who);
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);
  run("UPDATE users SET bio='Alice private bio',title='Alice CTO',skills='[\"rust\"]' WHERE id=?", alice.id);

  // Shared fixtures: a conversation between Alice and Bob, community content, follows, money.
  const conversationId = id();
  run('INSERT INTO conversations(id,subject,created_by) VALUES (?,?,?)', conversationId, 'Projet commun', bob.id);
  run('INSERT INTO conversation_members(conversation_id,user_id) VALUES (?,?),(?,?)', conversationId, alice.id, conversationId, bob.id);
  const aliceMessage = id();
  const bobMessage = id();
  run('INSERT INTO messages(id,conversation_id,sender_id,body) VALUES (?,?,?,?)', aliceMessage, conversationId, alice.id, 'Alice secret plan');
  run('INSERT INTO messages(id,conversation_id,sender_id,body) VALUES (?,?,?,?)', bobMessage, conversationId, bob.id, 'Bob private reply 42');
  const alicePost = id();
  const bobPost = id();
  const aliceComment = id();
  const bobComment = id();
  run('INSERT INTO posts(id,author_id,body) VALUES (?,?,?),(?,?,?)', alicePost, alice.id, 'Alice public post', bobPost, bob.id, 'Bob public post');
  run('INSERT INTO comments(id,post_id,author_id,body) VALUES (?,?,?,?),(?,?,?,?)', aliceComment, bobPost, alice.id, 'Alice comment', bobComment, alicePost, bob.id, 'Bob comment on Alice');
  run('INSERT INTO user_follows(follower_id,following_id) VALUES (?,?),(?,?)', alice.id, bob.id, bob.id, alice.id);
  const aliceProject = id();
  run("INSERT INTO projects(id,owner_id,title,summary,category,description) VALUES (?,?,?,?,?,?)", aliceProject, alice.id, 'Alice solo project', 'Résumé', 'dev', 'Private notes');
  run("INSERT INTO bookmarks(user_id,target_type,target_id) VALUES (?,'project',?)", bob.id, aliceProject);
  run("INSERT INTO notifications(id,user_id,kind,title) VALUES (?,?,'system','Bienvenue Alice')", id(), alice.id);
  const aliceTransaction = id();
  run("INSERT INTO transactions(id,user_id,kind,amount_cents) VALUES (?,?,'funding',500)", aliceTransaction, alice.id);
  postJournal({ idempotencyKey: 'privacy-test-credit', kind: 'adjustment', mode: 'sandbox', currency: 'EUR', refType: 'privacy-test', refId: 'credit',
    legs: [{ account: ledgerAccounts.userAvailable(alice.id), amountMinor: 1500 }, { account: ledgerAccounts.adjustments(), amountMinor: -1500 }] });
  const organizationId = id();
  run('INSERT INTO organizations(id,owner_id,name) VALUES (?,?,?)', organizationId, alice.id, 'Alice Studio');
  run("INSERT INTO organization_members(organization_id,user_id,role) VALUES (?,?,'owner'),(?,?,'member')", organizationId, alice.id, organizationId, bob.id);

  await t.test('export archive contains own data and registered modules, never secrets or other users’ private data', async () => {
    const created = await call<{ request: Json }>(alice, '/privacy/exports', { method: 'POST', body: {}, expected: 201 });
    assert.equal(created.data.request.status, 'ready');
    assert.match(created.data.request.download_url, /^\/api\/privacy\/exports\/[^/]+\/download$/);
    assert.equal(outbox(alice.email, 'privacy.export_ready').length, 1);

    const limited = await call(alice, '/privacy/exports', { method: 'POST', body: {}, expected: 429 });
    assert.ok(Number(limited.response.headers.get('retry-after')) > 3600, 'Retry-After announces the end of the 24 h window');

    const path = created.data.request.download_url.replace(/^\/api/, '');
    await call(bob, path, { expected: 404 });
    await call(null, path, { expected: 401 });
    const download = await call(alice, path);
    assert.match(download.response.headers.get('content-disposition') ?? '', /^attachment; filename="alpha-donnees-personnelles-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.match(download.response.headers.get('cache-control') ?? '', /no-store/);
    const archive = JSON.parse(download.text) as Json;
    assert.equal(archive.user_id, alice.id);
    assert.equal(archive.sections.account.email, alice.email);
    assert.equal(archive.sections.account.bio, 'Alice private bio');
    assert.deepEqual(archive.errors, []);
    assert.ok(archive.sections.sessions.length >= 1);
    assert.ok(archive.sections.projects.some((project: Json) => project.id === aliceProject));
    assert.deepEqual(archive.sections.messages.sent.map((message: Json) => message.body), ['Alice secret plan']);
    assert.ok(archive.sections.messages.conversations.some((conversation: Json) => conversation.id === conversationId && conversation.participant_count === 2));
    assert.ok(archive.sections.community.posts.some((post: Json) => post.id === alicePost));
    assert.ok(archive.sections.community.comments.some((comment: Json) => comment.id === aliceComment));
    assert.ok(archive.sections.demo_transactions.some((row: Json) => row.id === aliceTransaction));
    assert.equal(archive.sections.ledger_entries.length, 1);
    assert.deepEqual(archive.sections.legal_acceptances.map((row: Json) => row.document).sort(), ['privacy', 'terms']);
    assert.ok(archive.sections.audit_events.some((event: Json) => event.action === 'privacy.export.requested'));
    assert.ok(archive.sections.organizations.owned.some((organization: Json) => organization.id === organizationId));
    // Registered module handlers (other modules + this module's own) are included, secrets stripped.
    assert.equal(archive.modules['privacy-fixture'].data.marker, `fixture-${alice.id}`);
    assert.equal(archive.modules['privacy-fixture'].data.nested.note, 'kept');
    assert.ok(Array.isArray(archive.modules.privacy.data.requests));
    for (const forbidden of ['password_hash', 'token_hash', 'fixture-token-must-not-leak', 'fixture-secret-must-not-leak', 'Bob private reply 42', bob.email, '"api_token"', '"client_secret"']) {
      assert.ok(!download.text.includes(forbidden), `archive must not contain ${forbidden}`);
    }
    const stored = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', alice.id)!.password_hash;
    assert.ok(!download.text.includes(stored.split(':')[1]), 'no password hash material');
    const downloaded = one<{ download_count: number }>('SELECT download_count FROM privacy_requests WHERE id=?', created.data.request.id)!;
    assert.equal(downloaded.download_count, 1);

    const listed = await call<{ requests: Json[] }>(alice, '/privacy/requests');
    assert.equal(listed.data.requests[0].download_url, created.data.request.download_url);
    assert.ok(!('handled_by' in listed.data.requests[0]) && !('last_error' in listed.data.requests[0]), 'member view hides admin fields');

    run('UPDATE privacy_requests SET expires_at=? WHERE id=?', hoursAgo(1), created.data.request.id);
    await call(alice, path, { expected: 410 });
    assert.equal(one<{ status: string }>('SELECT status FROM privacy_requests WHERE id=?', created.data.request.id)!.status, 'completed');
  });

  await t.test('consents are opt-in, versioned and historised; hasConsent helper', async () => {
    const initial = await call<{ policy_version: string; consents: Json[]; history: Json[] }>(bob, '/privacy/consents');
    assert.equal(initial.data.policy_version, legalDocuments.privacy.version);
    assert.deepEqual(initial.data.consents.map((consent) => [consent.purpose, consent.granted]), [['marketing_email', false], ['product_updates', false], ['analytics', false]]);
    assert.equal(hasConsent(bob.id, 'marketing_email'), false);

    const granted = await call<{ changed: string[]; consents: Json[]; history: Json[] }>(bob, '/privacy/consents', { method: 'PUT', body: { marketing_email: true } });
    assert.deepEqual(granted.data.changed, ['marketing_email']);
    assert.equal(hasConsent(bob.id, 'marketing_email'), true);
    const again = await call<{ changed: string[] }>(bob, '/privacy/consents', { method: 'PUT', body: { marketing_email: true } });
    assert.deepEqual(again.data.changed, [], 'no event without a change');
    const mixed = await call<{ changed: string[]; history: Json[]; consents: Json[] }>(bob, '/privacy/consents', { method: 'PUT', body: { marketing_email: false, analytics: true } });
    assert.deepEqual(mixed.data.changed.sort(), ['analytics', 'marketing_email']);
    assert.equal(mixed.data.history.length, 3);
    assert.ok(mixed.data.history.every((event) => event.policy_version === legalDocuments.privacy.version && event.source === 'settings'));
    assert.equal(hasConsent(bob.id, 'marketing_email'), false);
    assert.equal(hasConsent(bob.id, 'analytics'), true);
    assert.ok(one("SELECT 1 FROM audit_events WHERE actor_id=? AND action='privacy.consents.updated'", bob.id));

    await call(bob, '/privacy/consents', { method: 'PUT', body: { unknown_purpose: true }, expected: 400 });
    await call(bob, '/privacy/consents', { method: 'PUT', body: { analytics: 'yes' }, expected: 400 });
    await call(null, '/privacy/consents', { expected: 401 });
    assert.throws(() => run("UPDATE consent_events SET granted=1 WHERE user_id=?", bob.id), /immutable|immuable/i);

    run("UPDATE consents SET policy_version='2025-01-old' WHERE user_id=? AND purpose='analytics'", bob.id);
    const outdated = await call<{ consents: Json[] }>(bob, '/privacy/consents');
    assert.equal(outdated.data.consents.find((consent) => consent.purpose === 'analytics')!.outdated, true);
    const confirmed = await call<{ changed: string[]; consents: Json[] }>(bob, '/privacy/consents', { method: 'PUT', body: { analytics: true } });
    assert.deepEqual(confirmed.data.changed, ['analytics'], 're-confirming under the new policy is recorded');
    assert.equal(confirmed.data.consents.find((consent) => consent.purpose === 'analytics')!.outdated, false);

    // Alice grants marketing: the erasure must withdraw it.
    await call(alice, '/privacy/consents', { method: 'PUT', body: { marketing_email: true } });
  });

  await t.test('legal documents: versions, placeholders from settings, safe markdown, acceptances', async () => {
    const list = await call<{ documents: Json[] }>(null, '/privacy/legal');
    assert.deepEqual(list.data.documents.map((document) => document.slug), ['terms', 'privacy', 'payments', 'tester_charter', 'seller_terms', 'legal_notice']);
    for (const document of list.data.documents) {
      if (document.slug === 'legal_notice') assert.equal(document.acceptable, false);
      else assert.equal(document.version, legalDocuments[document.slug as keyof typeof legalDocuments].version);
      assert.equal(document.pending, false, 'visitors have nothing pending');
    }
    const mine = await call<{ documents: Json[] }>(bob, '/privacy/legal');
    assert.deepEqual(mine.data.documents.filter((document) => document.pending).map((document) => document.slug), ['payments', 'tester_charter', 'seller_terms']);

    for (const slug of ['terms', 'privacy', 'payments', 'tester_charter', 'seller_terms', 'legal_notice']) {
      const { data } = await call<{ document: Json }>(null, `/privacy/legal/${slug}`);
      assert.equal(data.document.file_version_mismatch, false, `${slug} template version must match server/platform/legal.ts`);
      assert.match(data.document.content, /Modèle à faire valider par un juriste/);
      assert.ok(data.document.toc.length >= 3, `${slug} has a table of contents`);
      assert.ok(!/\{\{\s*[a-z_]+\s*\}\}/.test(data.document.content), `${slug}: every placeholder is substituted`);
    }
    await call(null, '/privacy/legal/unknown', { expected: 404 });

    const before = await call<{ document: Json }>(null, '/privacy/legal/legal_notice');
    assert.ok(before.data.document.missing.includes('raison sociale'));
    assert.match(before.data.document.content, /\\\[à compléter : raison sociale\\\]/);

    const payload = '<script>alert(1)</script> [clic](javascript:alert(1)) **gras** <img src=x onerror=alert(2)>';
    await call(bob, '/privacy/admin/controller', { method: 'PUT', body: { company_name: 'Pirate' }, expected: 403 });
    await call(admin, '/privacy/admin/controller', { method: 'PUT', body: { email: 'pas-un-email' }, expected: 400 });
    const saved = await call<{ controller: Json }>(admin, '/privacy/admin/controller', { method: 'PUT', body: {
      company_name: payload, legal_form: 'SAS', address: '1 rue de la Paix\n75002 Paris', registration: 'RCS Paris 123 456 789',
      email: 'contact@alpha.test', dpo_email: 'dpo@alpha.test', director: 'Jeanne Martin', host_name: 'Hébergeur SAS', host_address: '2 rue du Cloud, 59100 Roubaix',
    } });
    const partial = await call<{ document: Json }>(null, '/privacy/legal/legal_notice');
    assert.deepEqual([...partial.data.document.missing].sort(), ['capital social', 'numéro de TVA intracommunautaire', 'téléphone'], 'legal notice still lists LCEN fields left empty');
    await call(admin, '/privacy/admin/controller', { method: 'PUT', body: {
      company_name: payload, legal_form: 'SAS', address: '1 rue de la Paix\n75002 Paris', registration: 'RCS Paris 123 456 789', share_capital: '10 000 €',
      vat_number: 'FR12123456789', phone: '+33 1 23 45 67 89',
      email: 'contact@alpha.test', dpo_email: 'dpo@alpha.test', director: 'Jeanne Martin', host_name: 'Hébergeur SAS', host_address: '2 rue du Cloud, 59100 Roubaix',
    } });
    assert.equal(saved.data.controller.company_name, payload);
    assert.ok(one("SELECT 1 FROM audit_events WHERE actor_id=? AND action='privacy.admin.controller_updated'", admin.id));

    const after = await call<{ document: Json }>(null, '/privacy/legal/legal_notice');
    assert.deepEqual(after.data.document.missing, []);
    const nodes = inlineNodes(after.data.document.blocks);
    const texts = nodes.filter((node) => node.type === 'text').map((node) => node.text as string).join('\n');
    assert.ok(texts.includes(payload), 'the settings value is rendered literally as text');
    assert.ok(texts.includes('1 rue de la Paix, 75002 Paris'), 'newlines are flattened');
    assert.ok(texts.includes('dpo@alpha.test') && texts.includes('Hébergeur SAS'));
    for (const link of nodes.filter((node) => node.type === 'link')) {
      assert.ok(/^(\/(?![/\\])|#|https:\/\/|mailto:)/.test(link.href), `unsafe href ${link.href}`);
      assert.ok(!JSON.stringify(link).includes('javascript'), 'no link built from the settings payload');
    }
    assert.ok(!nodes.some((node) => node.type === 'strong' && JSON.stringify(node).includes('gras')), 'no markup from settings');
    const privacy = await call<{ document: Json }>(null, '/privacy/legal/privacy');
    assert.ok(inlineNodes(privacy.data.document.blocks).some((node) => node.type === 'text' && node.text.includes('dpo@alpha.test')));

    // Parser hardening, independently of the templates.
    assert.equal(safeHref('javascript:alert(1)'), null);
    assert.equal(safeHref('JaVaScRiPt:alert(1)'), null);
    assert.equal(safeHref('//evil.example/x'), null);
    assert.equal(safeHref('/\\evil.example'), null);
    assert.equal(safeHref('data:text/html,<script>'), null);
    assert.equal(safeHref('http://insecure.example'), null);
    assert.equal(safeHref('https://user:pw@example.com'), null);
    assert.equal(safeHref('https://www.cnil.fr/'), 'https://www.cnil.fr/');
    assert.equal(safeHref('/legal/privacy#cookies'), '/legal/privacy#cookies');
    const hostile = parseMarkdown('# T\n\n<b>x</b> [a](javascript:alert(1)) [b](//evil.example) [c](https://ok.example/p) <!-- hidden -->\n\n| a | b |\n|---|---|\n| <i>1</i> | [d](data:x) |');
    const hostileNodes = inlineNodes(hostile.blocks as Json[]);
    assert.deepEqual(hostileNodes.filter((node) => node.type === 'link').map((node) => node.href), ['https://ok.example/p']);
    assert.ok(hostileNodes.some((node) => node.type === 'text' && node.text.includes('<b>x</b>')), 'raw HTML stays text');

    await call(null, '/privacy/legal/accept', { method: 'POST', body: { documents: ['tester_charter'] }, expected: 401 });
    await call(bob, '/privacy/legal/accept', { method: 'POST', body: { documents: ['legal_notice'] }, expected: 400 });
    await call(bob, '/privacy/legal/accept', { method: 'POST', body: { documents: ['nope'] }, expected: 400 });
    const accepted = await call<{ documents: Json[]; acceptances: Json[] }>(bob, '/privacy/legal/accept', { method: 'POST', body: { documents: ['tester_charter', 'payments'] } });
    assert.equal(accepted.data.documents.find((document) => document.slug === 'tester_charter')!.pending, false);
    const history = await call<{ acceptances: Json[] }>(bob, '/privacy/legal/acceptances');
    assert.deepEqual(history.data.acceptances.map((row) => row.document).sort(), ['payments', 'privacy', 'terms', 'tester_charter']);
    assert.ok(history.data.acceptances.every((row) => row.current === true && typeof row.title === 'string'));
    const single = await call<{ document: Json }>(bob, '/privacy/legal/tester_charter');
    assert.equal(single.data.document.pending, false);
    assert.ok(single.data.document.accepted_at);
  });

  await t.test('erasure request: confirmation, re-authentication, blockers, scheduling and cancellation', async () => {
    resetLimits();
    const state = await call<{ request: Json | null; blockers: Json[]; requires_password: boolean; grace_days: number }>(alice, '/privacy/erasure');
    assert.equal(state.data.request, null);
    assert.equal(state.data.requires_password, true);
    assert.equal(state.data.grace_days, 30);
    assert.deepEqual(state.data.blockers.map((blocker) => blocker.code).sort(), ['balance', 'organization_owner']);
    assert.match(state.data.blockers.find((blocker) => blocker.code === 'balance')!.message, /15,00\s€/);

    await call(alice, '/privacy/erasure', { method: 'POST', body: { password, confirmation: 'supprimer' }, expected: 400 });
    await call(alice, '/privacy/erasure', { method: 'POST', body: { password: 'Wrong-password-123', confirmation: 'SUPPRIMER' }, expected: 403 });
    const blocked = await call<{ error: string; blockers: Json[] }>(alice, '/privacy/erasure', { method: 'POST', body: { password, confirmation: 'SUPPRIMER' }, expected: 409 });
    assert.equal(blocked.data.blockers.length, 2);
    assert.equal(one<{ total: number }>("SELECT COUNT(*) AS total FROM privacy_requests WHERE user_id=? AND kind='erasure'", alice.id)!.total, 0);

    // Resolve the blockers: withdraw the balance (ledger stays) and remove the other member.
    postJournal({ idempotencyKey: 'privacy-test-debit', kind: 'adjustment', mode: 'sandbox', currency: 'EUR', refType: 'privacy-test', refId: 'debit',
      legs: [{ account: ledgerAccounts.userAvailable(alice.id), amountMinor: -1500 }, { account: ledgerAccounts.adjustments(), amountMinor: 1500 }] });
    run('DELETE FROM organization_members WHERE organization_id=? AND user_id=?', organizationId, bob.id);
    resetLimits();

    const scheduled = await call<{ request: Json }>(alice, '/privacy/erasure', { method: 'POST', body: { password, confirmation: ' SUPPRIMER ', reason: 'Je quitte la plateforme' }, expected: 201 });
    assert.equal(scheduled.data.request.status, 'scheduled');
    const delay = Date.parse(scheduled.data.request.scheduled_for) - Date.now();
    assert.ok(delay > 29.9 * 86400000 && delay <= 30 * 86400000, 'scheduled 30 days ahead');
    assert.equal(outbox(alice.email, 'privacy.erasure_scheduled').length, 1);
    await call(alice, '/privacy/erasure', { method: 'POST', body: { password, confirmation: 'SUPPRIMER' }, expected: 409 });
    assert.equal((await call<{ request: Json }>(alice, '/privacy/erasure')).data.request!.id, scheduled.data.request.id);
    // Still within the grace period: the job does nothing.
    await runJob('privacy.erasure');
    assert.equal(one<{ name: string }>('SELECT name FROM users WHERE id=?', alice.id)!.name, 'Alice');

    const cancelled = await call<{ request: Json }>(alice, '/privacy/erasure', { method: 'DELETE' });
    assert.equal(cancelled.data.request.status, 'cancelled');
    assert.equal(outbox(alice.email, 'privacy.erasure_cancelled').length, 1);
    await call(alice, '/privacy/erasure', { method: 'DELETE', expected: 404 });

    // Rate limit on erasure attempts (5 per 15 minutes).
    resetLimits();
    for (let attempt = 0; attempt < 5; attempt++) await call(alice, '/privacy/erasure', { method: 'POST', body: { password: 'Wrong-password-123', confirmation: 'SUPPRIMER' }, expected: 403 });
    await call(alice, '/privacy/erasure', { method: 'POST', body: { password, confirmation: 'SUPPRIMER' }, expected: 429 });
    resetLimits();

    // Accounts without a password (OAuth only) need a sign-in from less than 10 minutes.
    run("UPDATE users SET password_hash='' WHERE id=?", dave.id);
    run('UPDATE sessions SET created_at=? WHERE user_id=?', hoursAgo(1), dave.id);
    const stale = await call<{ requires_password: boolean; recent_login: boolean }>(dave, '/privacy/erasure');
    assert.deepEqual([stale.data.requires_password, stale.data.recent_login], [false, false]);
    await call(dave, '/privacy/erasure', { method: 'POST', body: { confirmation: 'SUPPRIMER' }, expected: 403 });
    run('UPDATE sessions SET created_at=? WHERE user_id=?', new Date().toISOString(), dave.id);
    const daveRequest = await call<{ request: Json }>(dave, '/privacy/erasure', { method: 'POST', body: { confirmation: 'SUPPRIMER' }, expected: 201 });
    assert.equal(daveRequest.data.request.status, 'scheduled');
  });

  await t.test('admin authorization, request queue, rejection and early execution', async () => {
    await call(null, '/privacy/admin/overview', { expected: 401 });
    for (const path of ['/privacy/admin/overview', '/privacy/admin/requests', '/privacy/admin/retention', '/privacy/admin/controller', '/privacy/admin/register', '/privacy/admin/breaches']) {
      await call(bob, path, { expected: 403 });
    }
    await call(bob, '/privacy/admin/retention/run', { method: 'POST', body: { dry_run: true }, expected: 403 });
    await call(bob, '/privacy/admin/breaches', { method: 'POST', body: { title: 'x', detected_at: new Date().toISOString(), description: 'x' }, expected: 403 });

    const overview = await call<Json>(admin, '/privacy/admin/overview');
    assert.ok(overview.data.requests.some((row: Json) => row.kind === 'erasure' && row.status === 'scheduled' && row.total === 1));
    assert.deepEqual(overview.data.controller_missing, []);

    const queue = await call<{ requests: Json[] }>(admin, '/privacy/admin/requests?status=open&kind=erasure');
    assert.deepEqual(queue.data.requests.map((request) => request.user_id), [dave.id]);
    assert.equal(queue.data.requests[0].user_email, dave.email);
    assert.equal(queue.data.requests[0].due, false);
    await call(admin, '/privacy/admin/requests?status=bogus', { expected: 400 });

    // Admin processes a pending export (e.g. left by a crash) and rejects another with a legal reason.
    const pendingExport = id();
    run("INSERT INTO privacy_requests(id,user_id,kind,status,requested_at,updated_at) VALUES (?,?,'export','pending',?,?)", pendingExport, bob.id, daysAgo(40), daysAgo(40));
    const overdue = await call<{ requests: Json[] }>(admin, '/privacy/admin/requests?kind=export&status=pending');
    assert.equal(overdue.data.requests.find((request) => request.id === pendingExport)!.overdue, true, 'one-month deadline exceeded');
    const processed = await call<{ request: Json }>(admin, `/privacy/admin/requests/${pendingExport}/process`, { method: 'POST' });
    assert.equal(processed.data.request.status, 'ready');
    assert.equal(processed.data.request.handled_by, admin.id);
    const rejectedExport = id();
    run("INSERT INTO privacy_requests(id,user_id,kind,status,requested_at,updated_at) VALUES (?,?,'export','pending',?,?)", rejectedExport, bob.id, daysAgo(1), daysAgo(1));
    await call(admin, `/privacy/admin/requests/${rejectedExport}/reject`, { method: 'POST', body: { reason: 'court' }, expected: 400 });
    const rejected = await call<{ request: Json }>(admin, `/privacy/admin/requests/${rejectedExport}/reject`, { method: 'POST', body: { reason: 'Demande manifestement excessive (art. 12.5 RGPD) : export identique fourni hier.' } });
    assert.equal(rejected.data.request.status, 'rejected');
    assert.equal(outbox(bob.email, 'privacy.request_rejected').length, 1);
    await call(admin, `/privacy/admin/requests/${rejectedExport}/reject`, { method: 'POST', body: { reason: 'Encore une fois, refus.' }, expected: 409 });
    await call(admin, `/privacy/admin/requests/${pendingExport}/execute`, { method: 'POST', expected: 404 });

    // An admin cannot execute their own erasure.
    const own = id();
    run("INSERT INTO privacy_requests(id,user_id,kind,status,requested_at,scheduled_for,updated_at) VALUES (?,?,'erasure','scheduled',?,?,?)", own, admin.id, daysAgo(31), daysAgo(1), daysAgo(31));
    await call(admin, `/privacy/admin/requests/${own}/execute`, { method: 'POST', expected: 409 });
    run("UPDATE privacy_requests SET status='cancelled' WHERE id=?", own);

    // Early execution at the member's explicit request.
    const daveRequest = one<{ id: string }>("SELECT id FROM privacy_requests WHERE user_id=? AND kind='erasure' AND status='scheduled'", dave.id)!;
    const executed = await call<{ outcome: Json; request: Json }>(admin, `/privacy/admin/requests/${daveRequest.id}/execute`, { method: 'POST' });
    assert.equal(executed.data.outcome.status, 'completed');
    assert.equal(executed.data.request.status, 'completed');
    assert.equal(one<{ name: string }>('SELECT name FROM users WHERE id=?', dave.id)!.name, ERASED_NAME);
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='privacy.admin.erasure_executed' AND target_id=? AND detail LIKE '%\"early\":true%'", daveRequest.id));
    await call(admin, `/privacy/admin/requests/${daveRequest.id}/execute`, { method: 'POST', expected: 409 });
  });

  await t.test('erasure job anonymizes due accounts, keeps legal records, leaves FKs clean and is idempotent', async () => {
    resetLimits();
    const ledgerBefore = one<{ total: number }>('SELECT COUNT(*) AS total FROM ledger_entries WHERE account=?', ledgerAccounts.userAvailable(alice.id))!.total;
    assert.equal(ledgerBefore, 2);
    const scheduled = await call<{ request: Json }>(alice, '/privacy/erasure', { method: 'POST', body: { password, confirmation: 'SUPPRIMER' }, expected: 201 });
    const requestId = scheduled.data.request.id as string;
    run('UPDATE privacy_requests SET scheduled_for=? WHERE id=?', hoursAgo(1), requestId);
    assert.equal((await call<Json>(admin, '/privacy/admin/overview')).data.due_erasures, 1);
    const aliceCookie = new Map(alice.jar);

    await runJob('privacy.erasure');

    const request = one<{ status: string; processed_at: string; last_error: string }>('SELECT status,processed_at,last_error FROM privacy_requests WHERE id=?', requestId)!;
    assert.equal(request.status, 'completed', request.last_error);
    const user = one<Json>('SELECT name,email,password_hash,title,bio,skills,avatar_color,role FROM users WHERE id=?', alice.id)!;
    assert.deepEqual({ ...user }, { name: ERASED_NAME, email: erasedEmail(alice.id), password_hash: ERASED_PASSWORD_HASH, title: '', bio: '', skills: '[]', avatar_color: '#a59bb0', role: 'member' });
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM sessions WHERE user_id=?', alice.id)!.total, 0);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM notifications WHERE user_id=?', alice.id)!.total, 0);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM email_outbox WHERE user_id=? OR to_address=?', alice.id, alice.email)!.total, 0);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM user_follows WHERE follower_id=? OR following_id=?', alice.id, alice.id)!.total, 0);
    assert.equal(hasConsent(alice.id, 'marketing_email'), false, 'consents withdrawn');
    assert.ok(one("SELECT 1 FROM consent_events WHERE user_id=? AND source='erasure' AND granted=0", alice.id), 'withdrawal is historised');
    assert.ok(fixtureErased.includes(alice.id), 'registered module handlers were called');

    // Login is impossible, the old session is dead.
    await call(null, '/auth/login', { method: 'POST', body: { email: alice.email, password }, expected: 401 });
    await call(null, '/auth/login', { method: 'POST', body: { email: erasedEmail(alice.id), password }, expected: 401 });
    const ghost: Actor = { ...alice, jar: aliceCookie };
    assert.equal((await call<{ user: Json | null }>(ghost, '/auth/me')).data.user, null);
    await call(ghost, '/privacy/exports', { method: 'POST', body: {}, expected: 401 });

    // Other users' conversations stay intact; Alice's bodies are scrubbed, structure kept.
    const messages = all<{ id: string; sender_id: string; body: string }>('SELECT id,sender_id,body FROM messages WHERE conversation_id=? ORDER BY created_at,rowid', conversationId);
    assert.deepEqual(messages.map((message) => message.id), [aliceMessage, bobMessage]);
    assert.ok(messages[0].body.startsWith(SCRUBBED.message.slice(0, -1)), `scrubbed body: ${messages[0].body}`);
    assert.ok(!messages[0].body.includes('secret plan'), 'original body is gone');
    assert.equal(messages[1].body, 'Bob private reply 42');
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM conversation_members WHERE conversation_id=?', conversationId)!.total, 2);
    assert.equal(one<{ body: string }>('SELECT body FROM posts WHERE id=?', alicePost)!.body, SCRUBBED.post);
    assert.equal(one<{ body: string }>('SELECT body FROM comments WHERE id=?', aliceComment)!.body, SCRUBBED.comment);
    assert.equal(one<{ body: string }>('SELECT body FROM comments WHERE id=?', bobComment)!.body, 'Bob comment on Alice', 'others’ comments are kept');
    assert.equal(one<{ body: string }>('SELECT body FROM posts WHERE id=?', bobPost)!.body, 'Bob public post');
    assert.equal(one('SELECT 1 FROM projects WHERE id=?', aliceProject), undefined, 'solo project without references is deleted');
    assert.equal(one('SELECT 1 FROM bookmarks WHERE target_id=?', aliceProject), undefined);
    assert.equal(one('SELECT 1 FROM organizations WHERE id=?', organizationId), undefined, 'organization without other members is deleted');

    // Legal obligations: ledger, transactions, legal acceptances and audit are kept and point to the anonymized id.
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM ledger_entries WHERE account=?', ledgerAccounts.userAvailable(alice.id))!.total, ledgerBefore);
    assert.equal(one<{ user_id: string }>('SELECT user_id FROM transactions WHERE id=?', aliceTransaction)!.user_id, alice.id);
    assert.ok(one('SELECT 1 FROM legal_acceptances WHERE user_id=?', alice.id));
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='privacy.erasure.completed' AND target_id=?", alice.id));
    assert.deepEqual(all('PRAGMA foreign_key_check'), []);
    assert.equal(foreignKeyViolations(), 0);

    // Idempotent: rerunning the job, the request or the anonymization changes nothing.
    await runJob('privacy.erasure');
    assert.equal(executeErasure(requestId).status, 'skipped');
    const report = anonymizeUser(alice.id);
    assert.equal(report.profile, 0);
    assert.equal(report.messages, 0);
    assert.equal(report.posts, 0);
    assert.equal(one<{ email: string }>('SELECT email FROM users WHERE id=?', alice.id)!.email, erasedEmail(alice.id));
    assert.deepEqual(all('PRAGMA foreign_key_check'), []);
  });

  await t.test('erasure stays blocked while obligations are pending, then runs', async () => {
    const erin = actor('Erin');
    await register(erin);
    const orgId = id();
    run('INSERT INTO organizations(id,owner_id,name) VALUES (?,?,?)', orgId, erin.id, 'Erin Corp');
    run("INSERT INTO organization_members(organization_id,user_id,role) VALUES (?,?,'owner')", orgId, erin.id);
    const requestId = id();
    run("INSERT INTO privacy_requests(id,user_id,kind,status,requested_at,scheduled_for,updated_at) VALUES (?,?,'erasure','scheduled',?,?,?)", requestId, erin.id, daysAgo(31), hoursAgo(2), daysAgo(31));
    run("INSERT INTO organization_members(organization_id,user_id,role) VALUES (?,?,'member')", orgId, bob.id);
    await runJob('privacy.erasure');
    const blocked = one<{ status: string; last_error: string; attempts: number }>('SELECT status,last_error,attempts FROM privacy_requests WHERE id=?', requestId)!;
    assert.equal(blocked.status, 'scheduled');
    assert.match(blocked.last_error, /Erin Corp/);
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND title='Suppression de compte en attente'", erin.id));
    assert.equal(one<{ name: string }>('SELECT name FROM users WHERE id=?', erin.id)!.name, 'Erin');
    await runJob('privacy.erasure');
    assert.equal(one<{ total: number }>("SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND title='Suppression de compte en attente'", erin.id)!.total, 1, 'not re-notified for the same blockers');

    run('DELETE FROM organization_members WHERE organization_id=? AND user_id=?', orgId, bob.id);
    await runJob('privacy.erasure');
    assert.equal(one<{ status: string }>('SELECT status FROM privacy_requests WHERE id=?', requestId)!.status, 'completed');
    assert.equal(one<{ name: string }>('SELECT name FROM users WHERE id=?', erin.id)!.name, ERASED_NAME);
    assert.deepEqual(all('PRAGMA foreign_key_check'), []);
  });

  await t.test('withdrawals block erasure only while in flight (paid/failed/cancelled/rejected are terminal)', async () => {
    const wendy = actor('Wendy');
    await register(wendy);
    const available = ledgerAccounts.userAvailable(wendy.id);
    const leg = (account: string, amountMinor: number) => ({ account, amountMinor });
    const journal = (key: string, kind: string, refId: string, legs: { account: string; amountMinor: number }[]) =>
      postJournal({ idempotencyKey: `privacy-test-w-${key}`, kind, mode: 'sandbox', currency: 'EUR', refType: 'withdrawal', refId, legs });
    journal('credit', 'adjustment', 'credit', [leg('platform:adjustments', -4000), leg(available, 4000)]);
    const withdrawalCodes = () => erasureBlockers(wendy.id).filter((blocker) => blocker.code === 'withdrawal');
    const terminals = ['withdrawal.paid', 'withdrawal.failed', 'withdrawal.cancelled', 'withdrawal.rejected'];
    for (const [index, kind] of terminals.entries()) {
      const refId = `w-${index}`;
      journal(`req-${index}`, 'withdrawal.requested', refId, [leg(available, -1000), leg(ledgerAccounts.withdrawalsInFlight(), 1000)]);
      assert.equal(withdrawalCodes().length, 1, `in-flight withdrawal blocks before ${kind}`);
      const legs = kind === 'withdrawal.paid'
        ? [leg(ledgerAccounts.withdrawalsInFlight(), -1000), leg('platform:adjustments', 1000)]
        : [leg(ledgerAccounts.withdrawalsInFlight(), -1000), leg(available, 1000)];
      journal(`end-${index}`, kind, refId, legs);
      assert.equal(withdrawalCodes().length, 0, `${kind} is terminal`);
    }
  });

  await t.test('retention: settings validation, dry-run counts, purge job', async () => {
    const seed = {
      oldRead: id(), recentRead: id(), oldUnread: id(),
      oldSent: id(), recentSent: id(), oldFailed: id(), recentFailed: id(),
      oldAudit: id(), oldMoneyAudit: id(), ancientMoneyAudit: id(), recentAudit: id(),
      oldSignal: id(), recentSignal: id(),
    };
    run("INSERT INTO notifications(id,user_id,kind,title,read_at,created_at) VALUES (?,?,'system','old read',?,?)", seed.oldRead, bob.id, daysAgo(390), daysAgo(400));
    run("INSERT INTO notifications(id,user_id,kind,title,read_at,created_at) VALUES (?,?,'system','recent read',?,?)", seed.recentRead, bob.id, daysAgo(9), daysAgo(10));
    run("INSERT INTO notifications(id,user_id,kind,title,created_at) VALUES (?,?,'system','old unread',?)", seed.oldUnread, bob.id, daysAgo(400));
    const email = (emailId: string, status: string, age: number) => run(
      "INSERT INTO email_outbox(id,to_address,user_id,category,subject,text_body,status,created_at) VALUES (?,?,?,'test','s','b',?,?)", emailId, bob.email, bob.id, status, daysAgo(age));
    email(seed.oldSent, 'sent', 100); email(seed.recentSent, 'logged', 10); email(seed.oldFailed, 'failed', 200); email(seed.recentFailed, 'failed', 100);
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)', 'f'.repeat(64), bob.id, hoursAgo(1));
    run('INSERT INTO rate_limit_buckets(key,count,reset_at) VALUES (?,?,?)', 'privacy-test:expired', 3, hoursAgo(1));
    const auditRow = (auditId: string, action: string, age: number) => run(
      "INSERT INTO audit_events(id,actor_id,action,target_type,target_id,created_at) VALUES (?,?,?,'test','x',?)", auditId, bob.id, action, daysAgo(age));
    auditRow(seed.oldAudit, 'project.updated', 1200); auditRow(seed.oldMoneyAudit, 'payment.captured', 1200);
    auditRow(seed.ancientMoneyAudit, 'payments.refund', 3700); auditRow(seed.recentAudit, 'project.created', 30);
    const signals = one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='risk_signals'");
    if (signals) {
      run("INSERT INTO risk_signals(id,user_id,kind,created_at) VALUES (?,?,'login',?),(?,?,'login',?)", seed.oldSignal, bob.id, daysAgo(200), seed.recentSignal, bob.id, daysAgo(10));
    }

    await call(admin, '/privacy/admin/retention', { method: 'PUT', body: { audit_days: 100 }, expected: 400 });
    await call(admin, '/privacy/admin/retention', { method: 'PUT', body: { audit_days: 2000, audit_long_days: 1500 }, expected: 400 });
    await call(admin, '/privacy/admin/retention', { method: 'PUT', body: { audit_long_prefixes: ['DROP TABLE'] }, expected: 400 });
    await call(admin, '/privacy/admin/retention', { method: 'PUT', body: { unknown: 1 }, expected: 400 });
    const current = await call<{ settings: Json; defaults: Json }>(admin, '/privacy/admin/retention');
    assert.deepEqual(current.data.settings, current.data.defaults);

    const dry = await call<{ result: Json }>(admin, '/privacy/admin/retention/run', { method: 'POST', body: {} });
    assert.equal(dry.data.result.dry_run, true);
    const counts = Object.fromEntries((dry.data.result.categories as Json[]).map((category) => [category.key, category.count]));
    assert.ok((dry.data.result.categories as Json[]).every((category) => !category.error));
    assert.equal(counts.notifications_read, 1);
    assert.equal(counts.emails_sent, 1);
    assert.equal(counts.emails_failed, 1);
    assert.ok(counts.sessions_expired >= 1);
    assert.ok(counts.rate_limits >= 1);
    assert.equal(counts.audit_standard, 1);
    assert.equal(counts.audit_long, 1);
    if (signals) assert.equal(counts.risk_signals, 1);
    assert.ok(one('SELECT 1 FROM notifications WHERE id=?', seed.oldRead), 'dry run deletes nothing');
    assert.ok(one('SELECT 1 FROM audit_events WHERE id=?', seed.oldAudit));
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='privacy.admin.retention_dry_run'"));

    await runJob('privacy.retention');
    const exists = (table: string, rowId: string) => !!one(`SELECT 1 FROM ${table} WHERE id=?`, rowId);
    assert.deepEqual([exists('notifications', seed.oldRead), exists('notifications', seed.recentRead), exists('notifications', seed.oldUnread)], [false, true, true]);
    assert.deepEqual([exists('email_outbox', seed.oldSent), exists('email_outbox', seed.recentSent), exists('email_outbox', seed.oldFailed), exists('email_outbox', seed.recentFailed)], [false, true, false, true]);
    assert.deepEqual([exists('audit_events', seed.oldAudit), exists('audit_events', seed.oldMoneyAudit), exists('audit_events', seed.ancientMoneyAudit), exists('audit_events', seed.recentAudit)], [false, true, false, true]);
    if (signals) assert.deepEqual([exists('risk_signals', seed.oldSignal), exists('risk_signals', seed.recentSignal)], [false, true]);
    assert.equal(one('SELECT 1 FROM sessions WHERE token_hash=?', 'f'.repeat(64)), undefined);
    assert.equal(one('SELECT 1 FROM rate_limit_buckets WHERE key=?', 'privacy-test:expired'), undefined);
    assert.ok((await call<{ user: Json | null }>(bob, '/auth/me')).data.user, 'live sessions are kept');

    const after = await call<{ result: Json }>(admin, '/privacy/admin/retention/run', { method: 'POST', body: { dry_run: true } });
    const remaining = Object.fromEntries((after.data.result.categories as Json[]).map((category) => [category.key, category.count]));
    assert.equal(remaining.notifications_read + remaining.emails_sent + remaining.emails_failed + remaining.audit_standard + remaining.audit_long, 0);

    const disabled = await call<{ settings: Json }>(admin, '/privacy/admin/retention', { method: 'PUT', body: { enabled: false, notifications_read_days: 200 } });
    assert.equal(disabled.data.settings.enabled, false);
    assert.equal(disabled.data.settings.audit_days, 1095, 'partial updates keep other values');
    await call(admin, '/privacy/admin/retention', { method: 'PUT', body: { enabled: true, notifications_read_days: 365 } });
  });

  await t.test('processing register and breach register with the 72 h indicator', async () => {
    const register = await call<{ activities: Json[]; controller: Json }>(admin, '/privacy/admin/register');
    const ids = register.data.activities.map((activity) => activity.id);
    assert.ok(ids.includes('accounts') && ids.includes('module:privacy-fixture') && ids.includes('module:privacy'));
    assert.ok(register.data.activities.every((activity) => activity.name && activity.legal_basis && activity.retention));
    const download = await call(admin, '/privacy/admin/register/download');
    assert.match(download.response.headers.get('content-disposition') ?? '', /^attachment; filename="alpha-registre-traitements-/);
    assert.ok(Array.isArray(JSON.parse(download.text).activities));

    await call(admin, '/privacy/admin/breaches', { method: 'POST', body: { title: 'Futur', detected_at: new Date(Date.now() + 86400000).toISOString(), description: 'x' }, expected: 400 });
    await call(admin, '/privacy/admin/breaches', { method: 'POST', body: { title: 'Champ inconnu', detected_at: hoursAgo(1), description: 'x', evil: 1 }, expected: 400 });
    const overdue = await call<{ breach: Json }>(admin, '/privacy/admin/breaches', { method: 'POST', expected: 201, body: {
      title: 'Fuite de journaux', detected_at: hoursAgo(80), description: 'Journaux exposés', nature: ['confidentiality'], data_categories: ['e-mails'], affected_count: 120, risk_level: 'high',
    } });
    assert.equal(overdue.data.breach.deadline.state, 'overdue');
    assert.equal(overdue.data.breach.deadline.users_pending, true);
    const pending = await call<{ breach: Json }>(admin, '/privacy/admin/breaches', { method: 'POST', expected: 201, body: { title: 'Perte d’un portable', detected_at: hoursAgo(2), description: 'Chiffré ?' } });
    assert.equal(pending.data.breach.deadline.state, 'pending');
    assert.ok(pending.data.breach.deadline.hours_left >= 69 && pending.data.breach.deadline.hours_left <= 70);
    const minor = await call<{ breach: Json }>(admin, '/privacy/admin/breaches', { method: 'POST', expected: 201, body: { title: 'E-mail mal adressé', detected_at: hoursAgo(1), description: 'Une adresse', risk_level: 'none' } });
    assert.equal(minor.data.breach.deadline.state, 'not_required');

    const overview = await call<Json>(admin, '/privacy/admin/overview');
    assert.equal(overview.data.open_breaches, 3);
    assert.equal(overview.data.overdue_breaches, 1);

    await call(admin, `/privacy/admin/breaches/${pending.data.breach.id}`, { method: 'PATCH', body: { notified_cnil_at: hoursAgo(3) }, expected: 400 });
    const notified = await call<{ breach: Json }>(admin, `/privacy/admin/breaches/${pending.data.breach.id}`, { method: 'PATCH', body: { notified_cnil_at: hoursAgo(1), cnil_reference: 'CNIL-2026-1' } });
    assert.equal(notified.data.breach.deadline.state, 'notified_on_time');
    assert.equal(notified.data.breach.title, 'Perte d’un portable', 'patch keeps other fields');
    const late = await call<{ breach: Json }>(admin, `/privacy/admin/breaches/${overdue.data.breach.id}`, { method: 'PATCH', body: { notified_cnil_at: hoursAgo(1), notified_users_at: hoursAgo(1), status: 'closed' } });
    assert.equal(late.data.breach.deadline.state, 'notified_late');
    assert.equal(late.data.breach.deadline.users_pending, false);

    await call(admin, `/privacy/admin/breaches/${minor.data.breach.id}`, { method: 'DELETE', expected: 204 });
    run('UPDATE breach_register SET created_at=? WHERE id=?', daysAgo(2), overdue.data.breach.id);
    await call(admin, `/privacy/admin/breaches/${overdue.data.breach.id}`, { method: 'DELETE', expected: 409 });
    await call(admin, '/privacy/admin/breaches/missing', { method: 'PATCH', body: { status: 'closed' }, expected: 404 });
    const list = await call<{ breaches: Json[] }>(admin, '/privacy/admin/breaches');
    assert.equal(list.data.breaches.length, 2);
    for (const action of ['privacy.admin.breach_created', 'privacy.admin.breach_updated', 'privacy.admin.breach_deleted', 'privacy.admin.register_downloaded']) {
      assert.ok(one('SELECT 1 FROM audit_events WHERE actor_id=? AND action=?', admin.id, action), `${action} audited`);
    }
  });
});
