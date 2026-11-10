import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const filesRoot = resolve('data', `.test-files-v4-${process.pid}`);
process.env.FILES_DIR = filesRoot;
delete process.env.CLAMAV_HOST;
delete process.env.CLAMAV_PORT;
delete process.env.CLAMAV_TIMEOUT_MS;

const { app } = await import('../server/app.js');
const { all, one, run, transaction } = await import('../server/db.js');
const { runJob } = await import('../server/platform/jobs.js');
const { setSetting } = await import('../server/platform/settings.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');
const service = await import('../server/files/service.js');
const { settleScans } = await import('../server/files/scan.js');
const { objectPath, filesDir } = await import('../server/files/storage.js');
const { sanitizeFilename, verifyContent, fileKind } = await import('../server/files/policy.js');
const { eicarTestString, parseClamdReply } = await import('../server/files/clamav.js');
const { sha256Hex } = await import('../server/platform/secrets.js');

const WEB_HEADERS = { 'X-Alpha-Client': 'web', Origin: 'http://127.0.0.1:5173' };
const EICAR = eicarTestString();

interface Actor { id: string; name: string; email: string; cookie: string }
type Json = Record<string, any>;

/** Minimal clamd speaking the zINSTREAM / zPING / zVERSION protocol. */
function fakeClamd() {
  const state = { scans: 0, lastContent: Buffer.alloc(0), chunkSizes: [] as number[] };
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const parts: Buffer[] = [];
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 1);
        if (command === 'zPING') { socket.end('PONG\0'); return; }
        if (command === 'zVERSION') { socket.end('ClamAV 1.4.1/27500/Fake clamd\0'); return; }
        if (command !== 'zINSTREAM') { socket.end('UNKNOWN COMMAND\0'); return; }
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const content = Buffer.concat(parts);
          state.scans += 1;
          state.lastContent = content;
          socket.end(content.includes(Buffer.from(EICAR, 'latin1')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          buffer = Buffer.alloc(0);
          return;
        }
        if (buffer.length < 4 + size) return;
        state.chunkSizes.push(size);
        parts.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  return { server, state };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

const zip = (marker: string, size = 2048) => {
  const body = Buffer.alloc(size, 0x41);
  Buffer.from(marker).copy(body, 64);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(body, 0);
  return body;
};
const png = (extra = 'pixels') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`\0\0\0\rIHDR${extra}`)]);
const pdf = (text = 'Rapport') => Buffer.from(`%PDF-1.7\n% ${text}\n1 0 obj << >> endobj\ntrailer\n%%EOF\n`);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86400000;

test('V4 secure files & antivirus', async (t) => {
  rmSync(filesRoot, { recursive: true, force: true });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const clamd = fakeClamd();
  const clamdPort = await listen(clamd.server);
  t.after(async () => {
    await settleScans();
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await new Promise<void>((done) => clamd.server.close(() => done()));
    rmSync(filesRoot, { recursive: true, force: true });
  });

  async function request<T = Json>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : WEB_HEADERS),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) actor.cookie = cookie.split(';', 1)[0];
    const data = (text && (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text) as T;
    if (expected >= 400) assert.equal(typeof (data as Json).error, 'string', 'Errors must be actionable JSON');
    return data;
  }

  async function upload(actor: Actor | null, fields: Record<string, string>, name: string, content: Buffer | string, expected = 201): Promise<Json> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([new Uint8Array(Buffer.from(content))]), name);
    const response = await fetch(`${base}/files`, { method: 'POST', headers: { ...WEB_HEADERS, ...(actor?.cookie ? { Cookie: actor.cookie } : {}) }, body: form });
    const text = await response.text();
    assert.equal(response.status, expected, `upload ${name}: ${text}`);
    const data = JSON.parse(text) as Json;
    if (expected >= 400) assert.equal(typeof data.error, 'string');
    return data;
  }

  async function download(actor: Actor | null, fileId: string, query = '') {
    return fetch(`${base}/files/${fileId}/download${query}`, { headers: actor?.cookie ? { Cookie: actor.cookie } : {} });
  }

  const actors: Record<string, Actor> = {};
  for (const name of ['Admin', 'Olivia', 'Tom', 'Paul', 'Oscar', 'Bea', 'Sam', 'Gaston']) {
    const actor: Actor = { id: '', name, email: `${name.toLowerCase()}-files@example.test`, cookie: '' };
    const data = await request<{ user: { id: string } }>(actor, '/auth/register', 201, 'POST', {
      name, email: actor.email, password: 'Alpha-files-password-2026!', accept_terms: true,
    });
    actor.id = data.user.id;
    actors[name] = actor;
  }
  const { Admin: admin, Olivia: owner, Tom: tester, Paul: applicant, Oscar: outsider, Bea: buyer, Sam: seller, Gaston: leaver } = actors;
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);

  // Fixtures: campaign with an accepted tester (mission) and a pending applicant, a paid order, a conversation.
  run(`INSERT INTO projects(id,owner_id,title,summary,category,visibility) VALUES ('p1',?,'Projet','Résumé','tech','public')`, owner.id);
  run(`INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline) VALUES ('c1','p1',?,'Campagne','Description',1000,5,'2099-01-01')`, owner.id);
  run("INSERT INTO applications(id,campaign_id,tester_id,motivation,status) VALUES ('a-tom','c1',?,'Motivé','accepted'),('a-paul','c1',?,'Motivé','pending')", tester.id, applicant.id);
  run("INSERT INTO missions(id,campaign_id,tester_id,application_id,status) VALUES ('m1','c1',?,'a-tom','in_progress')", tester.id);
  run(`INSERT INTO listings(id,seller_id,title,description,kind,price_cents,license,deliverables) VALUES ('l1',?,'Kit','Description','software',1000,'MIT','Code')`, seller.id);
  run("INSERT INTO orders(id,listing_id,buyer_id,seller_id,price_cents,status) VALUES ('o1','l1',?,?,1000,'paid'),('o2','l1',?,?,1000,'refunded')", buyer.id, seller.id, buyer.id, seller.id);
  run("INSERT INTO conversations(id,subject,created_by) VALUES ('conv1','Sujet',?)", tester.id);
  run("INSERT INTO conversation_members(conversation_id,user_id) VALUES ('conv1',?),('conv1',?)", tester.id, owner.id);

  const build = zip('ALPHA-PLAINTEXT-MARKER build v1', 300 * 1024);
  let buildFile: Json = {};

  await t.test('storage directory is private and upload hints are published', async () => {
    assert.equal(filesDir(), filesRoot);
    const policies = await request(owner, '/files/policies');
    const campaignBuild = policies.policies.find((policy: Json) => policy.purpose === 'campaign_build');
    assert.equal(campaignBuild.max_bytes, 200 * 1024 * 1024);
    assert.ok(campaignBuild.extensions.includes('.apk') && campaignBuild.extensions.includes('.AppImage'.toLowerCase()));
    assert.ok(!policies.policies.some((policy: Json) => ['privacy_export', 'sandbox_artifact'].includes(policy.purpose)));
    assert.equal(policies.quota.used_bytes, 0);
    await request(null, '/files/policies', 401);
  });

  await t.test('upload happy path: streamed, encrypted at rest, integrity-checked roundtrip', async () => {
    buildFile = await upload(owner, { purpose: 'campaign_build', resource_type: 'campaign', resource_id: 'c1' }, 'build v1.zip', build);
    assert.equal(buildFile.original_name, 'build v1.zip');
    assert.equal(buildFile.mime_type, 'application/zip');
    assert.equal(buildFile.size_bytes, build.length);
    assert.equal(buildFile.sha256, sha256Hex(build));
    assert.equal(buildFile.scan_status, 'skipped', 'no scanner configured and scanning not required outside production');
    assert.equal(buildFile.resource_type, 'campaign');
    assert.equal(buildFile.available, true);
    assert.equal(buildFile.can_delete, true);

    const row = service.fileRow(buildFile.id)!;
    assert.equal(row.encrypted, 1);
    assert.match(row.storage_key, /^[a-f0-9]{40}$/);
    assert.ok(!row.storage_key.includes(buildFile.id));
    assert.match(row.key_fingerprint ?? '', /^[a-f0-9]{16}$/);
    assert.equal(row.detected_kind, 'zip');
    const path = objectPath(row.storage_key);
    assert.ok(path.startsWith(filesRoot));
    const onDisk = readFileSync(path);
    assert.notDeepEqual(onDisk, build);
    assert.ok(onDisk.length > build.length, 'ciphertext carries a header and per-segment tags');
    assert.equal(onDisk.indexOf(Buffer.from('ALPHA-PLAINTEXT-MARKER')), -1, 'plaintext never reaches the disk');
    assert.equal(onDisk.subarray(0, 3).toString(), 'ALF');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.equal(statSync(filesRoot).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(filesRoot, 'tmp')), [], 'temp file committed');

    assert.deepEqual(await service.readFileBuffer(buildFile.id), build);
    const response = await download(owner, buildFile.id);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), build);

    // Tampering with the ciphertext (or truncating it) is detected by AES-GCM.
    const copy = await service.storeBuffer({ ownerId: owner.id, purpose: 'sandbox_artifact', name: 'copie.zip', mimeType: 'application/zip', data: build, skipScan: true });
    const copyPath = objectPath(service.fileRow(copy.id)!.storage_key);
    const tampered = Buffer.from(readFileSync(copyPath));
    tampered[100000] ^= 0x01;
    writeFileSync(copyPath, tampered);
    await assert.rejects(service.readFileBuffer(copy.id));
    writeFileSync(copyPath, tampered.subarray(0, tampered.length - 70000));
    await assert.rejects(service.readFileBuffer(copy.id));
  });

  await t.test('content validation: extension + magic bytes, markup, purposes, multipart rules', async () => {
    const mismatch = await upload(tester, { purpose: 'message_attachment' }, 'photo.png', 'ceci est du texte', 415);
    assert.match(mismatch.error, /ne correspond pas au format PNG/);
    await upload(tester, { purpose: 'message_attachment' }, 'contrat.pdf', zip('x'), 415);
    await upload(tester, { purpose: 'message_attachment' }, 'archive.zip', pdf(), 415);
    const html = await upload(tester, { purpose: 'message_attachment' }, 'notes.txt', '<!DOCTYPE html><html><script>alert(1)</script></html>', 415);
    assert.match(html.error, /HTML/);
    await upload(tester, { purpose: 'message_attachment' }, 'notes.txt', 'Bonjour\n<script>steal()</script>', 415);
    await upload(tester, { purpose: 'message_attachment' }, 'image.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 415);
    await upload(tester, { purpose: 'message_attachment' }, 'polyglot.png', png('<script>alert(1)</script>'), 415);
    await upload(tester, { purpose: 'message_attachment' }, 'setup.exe', Buffer.from('MZ\x90\x00'), 415);
    await upload(tester, { purpose: 'kyc_document' }, 'id.zip', zip('id'), 415);
    await upload(tester, { purpose: 'privacy_export' }, 'export.zip', zip('x'), 400);
    await upload(tester, { purpose: 'sandbox_artifact' }, 'log.txt', 'x', 400);
    await upload(tester, { purpose: 'nimporte' }, 'log.txt', 'x', 400);
    await upload(tester, {}, 'log.txt', 'x', 400);
    await upload(tester, { purpose: 'message_attachment', resource_type: 'conversation' }, 'log.txt', 'x', 400);
    await upload(tester, { purpose: 'message_attachment', resource_type: 'campaign', resource_id: 'c1' }, 'log.txt', 'x', 400);
    await upload(tester, { purpose: 'message_attachment', extra: 'x' }, 'log.txt', 'x', 400);
    await upload(tester, { purpose: 'message_attachment' }, 'vide.txt', '', 400);
    await upload(null, { purpose: 'message_attachment' }, 'log.txt', 'x', 401);

    // Fields after the file are refused (authorization must happen before streaming).
    const late = new FormData();
    late.append('file', new Blob(['texte']), 'a.txt');
    late.append('purpose', 'message_attachment');
    let response = await fetch(`${base}/files`, { method: 'POST', headers: { ...WEB_HEADERS, Cookie: tester.cookie }, body: late });
    assert.equal(response.status, 400);
    const twice = new FormData();
    twice.append('purpose', 'message_attachment');
    twice.append('file', new Blob(['un']), 'a.txt');
    twice.append('file', new Blob(['deux']), 'b.txt');
    response = await fetch(`${base}/files`, { method: 'POST', headers: { ...WEB_HEADERS, Cookie: tester.cookie }, body: twice });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/files`, { method: 'POST', headers: { ...WEB_HEADERS, Cookie: tester.cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 415);
    response = await fetch(`${base}/files`, { method: 'POST', headers: { Cookie: tester.cookie }, body: new FormData() });
    assert.equal(response.status, 403, 'CSRF header required');

    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM files WHERE owner_id=?", tester.id)!.count, 0, 'nothing stored for rejected uploads');
    assert.deepEqual(readdirSync(join(filesRoot, 'tmp')), [], 'rejected uploads leave no temp file');

    assert.ok(verifyContent(fileKind('json')!, Buffer.from('{"ok":true}'), Buffer.alloc(0), 11).ok);
    assert.ok(!verifyContent(fileKind('txt')!, Buffer.from([0x61, 0x00, 0x62]), Buffer.alloc(0), 3).ok, 'binary data is not text');
  });

  await t.test('per-purpose size limit returns 413 (policy overrides via settings)', async () => {
    setSetting('files.policies', { message_attachment: { max_bytes: 2048 } }, admin.id);
    const tooBig = await upload(tester, { purpose: 'message_attachment' }, 'gros.txt', 'a'.repeat(10000), 413);
    assert.match(tooBig.error, /2048|0 Mo|Mo maximum/);
    await upload(tester, { purpose: 'message_attachment' }, 'petit.txt', 'a'.repeat(2048), 201);
    const policies = await request(tester, '/files/policies');
    assert.equal(policies.policies.find((policy: Json) => policy.purpose === 'message_attachment').max_bytes, 2048);
    setSetting('files.policies', {}, admin.id);
    assert.deepEqual(readdirSync(join(filesRoot, 'tmp')), []);
  });

  await t.test('filenames are sanitized (paths, controls, bidi, reserved, length)', async () => {
    const stored = await upload(tester, { purpose: 'message_attachment' }, '../../etc/<rapport>|final.txt', 'Journal', 201);
    assert.equal(stored.original_name, '_rapport__final.txt');
    assert.equal(sanitizeFilename('..\\..\\Windows\\system32\\evil.txt'), 'evil.txt');
    assert.equal(sanitizeFilename('facture\u202Etxt.exe'), 'facturetxt.exe');
    assert.equal(sanitizeFilename('a\u0000b\u0007c\u200B.pdf'), 'abc.pdf');
    assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
    assert.equal(sanitizeFilename('   ...   '), 'fichier');
    const long = sanitizeFilename(`${'é'.repeat(300)}.tar.gz`);
    assert.equal([...long].length, 180);
    assert.ok(long.endsWith('.tar.gz'));
  });

  await t.test('upload authorization depends on the target resource', async () => {
    await upload(outsider, { purpose: 'campaign_build', resource_type: 'campaign', resource_id: 'c1' }, 'b.zip', zip('x'), 403);
    await upload(tester, { purpose: 'campaign_build', resource_type: 'campaign', resource_id: 'c1' }, 'b.zip', zip('x'), 403);
    await upload(owner, { purpose: 'campaign_build', resource_type: 'campaign', resource_id: 'inconnue' }, 'b.zip', zip('x'), 404);
    await upload(outsider, { purpose: 'mission_attachment', resource_type: 'mission', resource_id: 'm1' }, 'r.txt', 'x', 403);
    await upload(applicant, { purpose: 'mission_attachment', resource_type: 'mission', resource_id: 'm1' }, 'r.txt', 'x', 403);
    await upload(buyer, { purpose: 'listing_delivery', resource_type: 'order', resource_id: 'o1' }, 'd.zip', zip('x'), 403);
    await upload(seller, { purpose: 'listing_delivery', resource_type: 'order', resource_id: 'o2' }, 'd.zip', zip('x'), 409);
    await upload(outsider, { purpose: 'message_attachment', resource_type: 'conversation', resource_id: 'conv1' }, 'm.txt', 'x', 403);
    await upload(tester, { purpose: 'kyc_document', resource_type: 'kyc', resource_id: owner.id }, 'id.png', png(), 403);
  });

  const fixtures: Record<string, Json> = {};

  await t.test('read authorization matrix (owner / admin / tester / buyer / outsiders)', async () => {
    fixtures.mission = await upload(tester, { purpose: 'mission_attachment', resource_type: 'mission', resource_id: 'm1' }, 'capture.png', png());
    fixtures.delivery = await upload(seller, { purpose: 'listing_delivery', resource_type: 'order', resource_id: 'o1' }, 'livrable.zip', zip('livraison'));
    fixtures.message = await upload(tester, { purpose: 'message_attachment', resource_type: 'conversation', resource_id: 'conv1' }, 'log.txt', 'Journal de test');
    fixtures.export = await service.storeBuffer({ ownerId: owner.id, purpose: 'privacy_export', name: 'export.zip', mimeType: 'application/zip', data: zip('export'), skipScan: true });
    run(`INSERT INTO sandbox_runs(id,requester_id,campaign_id,file_id,profile_id,image,command,limits,container_name)
      VALUES ('run-1',?,'c1',?,'default','alpine:3.20','["sh"]','{}','alpha-sbx-test-1')`, tester.id, buildFile.id);
    fixtures.artifact = await service.storeBuffer({ ownerId: tester.id, purpose: 'sandbox_artifact', name: 'run.log', mimeType: 'text/plain',
      data: Buffer.from('sortie du bac à sable'), resourceType: 'sandbox_run', resourceId: 'run-1', skipScan: true });
    assert.equal(fixtures.artifact.scan_status, 'skipped');

    const matrix: [string, Json, Actor | null, number][] = [
      ['build/owner', buildFile, owner, 200], ['build/tester', buildFile, tester, 200], ['build/admin', buildFile, admin, 200],
      ['build/applicant', buildFile, applicant, 404], ['build/outsider', buildFile, outsider, 404], ['build/buyer', buildFile, buyer, 404],
      ['build/anonymous', buildFile, null, 401],
      ['mission/tester', fixtures.mission, tester, 200], ['mission/campaign-owner', fixtures.mission, owner, 200],
      ['mission/applicant', fixtures.mission, applicant, 404], ['mission/outsider', fixtures.mission, outsider, 404],
      ['delivery/seller', fixtures.delivery, seller, 200], ['delivery/buyer', fixtures.delivery, buyer, 200],
      ['delivery/outsider', fixtures.delivery, outsider, 404], ['delivery/admin', fixtures.delivery, admin, 200],
      ['message/member', fixtures.message, owner, 200], ['message/outsider', fixtures.message, outsider, 404],
      ['export/owner', fixtures.export, owner, 200], ['export/admin', fixtures.export, admin, 404], ['export/tester', fixtures.export, tester, 404],
      ['artifact/requester', fixtures.artifact, tester, 200], ['artifact/campaign-owner', fixtures.artifact, owner, 200],
      ['artifact/outsider', fixtures.artifact, outsider, 404],
    ];
    for (const [label, file, actor, expected] of matrix) {
      const metadata = await fetch(`${base}/files/${file.id}`, { headers: actor ? { Cookie: actor.cookie } : {} });
      assert.equal(metadata.status, expected, `metadata ${label}`);
      const response = await download(actor, file.id);
      assert.equal(response.status, expected, `download ${label}`);
      await response.arrayBuffer();
    }

    // Buyers lose access when the order is refunded; the seller keeps it.
    run("UPDATE orders SET status='refunded' WHERE id='o1'");
    assert.equal((await download(buyer, fixtures.delivery.id)).status, 404);
    assert.equal((await download(seller, fixtures.delivery.id)).status, 200);
    run("UPDATE orders SET status='paid' WHERE id='o1'");
    // A cancelled mission removes the tester from campaign builds (no accepted application either).
    assert.equal(service.canReadFile(tester.id, service.getFile(buildFile.id)!), true);
    assert.equal(service.canReadFile('nobody', service.getFile(buildFile.id)!), false);

    const listed = await request<Json[]>(tester, '/files?resource_type=campaign&resource_id=c1');
    assert.deepEqual(listed.map((file) => file.id), [buildFile.id]);
    assert.equal(listed[0].can_delete, false);
    assert.deepEqual(await request(outsider, '/files?resource_type=campaign&resource_id=c1'), []);
    await request(outsider, '/files?resource_type=evil&resource_id=c1', 400);
    const mine = await request<Json[]>(tester, '/files');
    assert.ok(mine.every((file) => file.owner_id === tester.id));
    assert.deepEqual(service.filesFor('mission', 'm1').map((file) => file.id), [fixtures.mission.id]);
    await request(owner, '/files/not-a-uuid', 404);
  });

  await t.test('download headers prevent rendering and sniffing', async () => {
    const report = await upload(tester, { purpose: 'mission_attachment', resource_type: 'mission', resource_id: 'm1' }, 'Rapport été (final).pdf', pdf('été'));
    const response = await download(owner, report.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="Rapport ete (final).pdf"; filename*=UTF-8''Rapport%20%C3%A9t%C3%A9%20%28final%29.pdf`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-length'), String(pdf('été').length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf('été'));

    const pdfInline = await download(owner, report.id, '?inline=1');
    assert.equal(pdfInline.headers.get('content-type'), 'application/octet-stream', 'only safe images are served inline');
    assert.match(pdfInline.headers.get('content-disposition') ?? '', /^attachment;/);
    await pdfInline.arrayBuffer();
    const image = await download(owner, fixtures.mission.id, '?inline=1');
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(image.headers.get('content-disposition') ?? '', /^inline; filename="capture.png"/);
    assert.equal(image.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    await image.arrayBuffer();
    assert.equal((await request(owner, `/files/${fixtures.mission.id}`)).preview_url, `/api/files/${fixtures.mission.id}/download?inline=1`);
  });

  await t.test('attach rules: owner only, authorised resource, single resource, idempotent', async () => {
    const loose = await upload(tester, { purpose: 'mission_attachment' }, 'preuve.txt', 'Étapes de reproduction');
    assert.equal(loose.resource_type, null);
    await request(owner, `/files/${loose.id}/attach`, 404, 'POST', { resource_type: 'mission', resource_id: 'm1' });
    await request(tester, `/files/${loose.id}/attach`, 400, 'POST', { resource_type: 'campaign', resource_id: 'c1' });
    await request(tester, `/files/${loose.id}/attach`, 404, 'POST', { resource_type: 'mission', resource_id: 'inconnue' });
    const attached = await request(tester, `/files/${loose.id}/attach`, 200, 'POST', { resource_type: 'mission', resource_id: 'm1' });
    assert.equal(attached.resource_id, 'm1');
    assert.ok(service.fileRow(loose.id)!.attached_at);
    await request(tester, `/files/${loose.id}/attach`, 200, 'POST', { resource_type: 'mission', resource_id: 'm1' });
    run(`INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline) VALUES ('c2','p1',?,'Campagne 2','Description',1000,5,'2099-01-01')`, owner.id);
    run("INSERT INTO applications(id,campaign_id,tester_id,motivation,status) VALUES ('a-tom2','c2',?,'Motivé','accepted')", tester.id);
    run("INSERT INTO missions(id,campaign_id,tester_id,application_id,status) VALUES ('m2','c2',?,'a-tom2','in_progress')", tester.id);
    await request(tester, `/files/${loose.id}/attach`, 409, 'POST', { resource_type: 'mission', resource_id: 'm2' });

    const build2 = await upload(outsider, { purpose: 'campaign_build' }, 'pirate.zip', zip('pirate'));
    await request(outsider, `/files/${build2.id}/attach`, 403, 'POST', { resource_type: 'campaign', resource_id: 'c1' });

    // Service-level attach inside the caller's transaction (rolled back with it).
    const draft = await upload(owner, { purpose: 'campaign_build' }, 'v2.zip', zip('v2'));
    assert.throws(() => transaction(() => {
      service.attachFile(draft.id, owner.id, 'campaign', 'c1');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(service.getFile(draft.id)!.resource_id, null);
    transaction(() => service.attachFile(draft.id, owner.id, 'campaign', 'c1'));
    assert.equal(service.getFile(draft.id)!.resource_id, 'c1');
    assert.throws(() => service.attachFile(draft.id, tester.id, 'campaign', 'c1'), /propres fichiers/);
  });

  await t.test('per-user storage quota', async () => {
    const used = service.usedQuotaBytes(outsider.id);
    setSetting('files.quota', { bytes_per_user: used + 3000 }, admin.id);
    await upload(outsider, { purpose: 'message_attachment' }, 'q1.txt', 'q'.repeat(2000));
    const over = await upload(outsider, { purpose: 'message_attachment' }, 'q2.txt', 'q'.repeat(2000), 413);
    assert.match(over.error, /quota/);
    setSetting('files.quota', { bytes_per_user: used + 2000 }, admin.id);
    const full = await upload(outsider, { purpose: 'message_attachment' }, 'q3.txt', 'q', 413);
    assert.match(full.error, /quota/);
    setSetting('files.quota', { bytes_per_user: 2 * 1024 ** 3 }, admin.id);
    assert.equal((await request(outsider, '/files/policies')).quota.used_bytes, used + 2000);
  });

  await t.test('KYC documents: owner and admins only, every admin access is logged', async () => {
    const kyc = await upload(leaver, { purpose: 'kyc_document', resource_type: 'kyc', resource_id: leaver.id }, 'passeport.png', png('passport'));
    fixtures.kyc = kyc;
    await request(leaver, `/files/${kyc.id}`);
    assert.equal((await download(leaver, kyc.id)).status, 200);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM file_access_log')!.count, 0, 'owner accesses are not logged');
    await request(outsider, `/files/${kyc.id}`, 404);
    await request(admin, `/files/${kyc.id}?reason=${encodeURIComponent('Contrôle LCB-FT')}`);
    const response = await download(admin, kyc.id, '?reason=V%C3%A9rification');
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png('passport'));
    await request(admin, `/files?resource_type=kyc&resource_id=${leaver.id}`);
    await service.readFileBuffer(kyc.id, { actorId: admin.id, reason: 'Revue de conformité' });
    const log = all<{ actor_id: string; action: string; reason: string }>('SELECT actor_id,action,reason FROM file_access_log WHERE file_id=? ORDER BY at, rowid', kyc.id);
    assert.deepEqual(log.map((entry) => [entry.action, entry.reason]), [
      ['metadata', 'Contrôle LCB-FT'], ['download', 'Vérification'], ['list', 'Consultation administrative'], ['read', 'Revue de conformité'],
    ]);
    assert.ok(log.every((entry) => entry.actor_id === admin.id));
    const adminLog = await request<Json[]>(admin, `/files/admin/access-log?file_id=${kyc.id}`);
    assert.equal(adminLog.length, 4);
    assert.equal(adminLog[0].actor_name, 'Admin');
    await request(leaver, '/files/admin/access-log', 403);
    const unsent = await upload(leaver, { purpose: 'kyc_document', resource_type: 'kyc', resource_id: leaver.id }, 'mauvaise-piece.png', png('wrong'));
    await request(leaver, `/files/${unsent.id}`, 204, 'DELETE');
    fixtures.kycUnsent = unsent;
    run("INSERT INTO kyc_profiles(user_id,status,submitted_at) VALUES (?,'submitted',?)", leaver.id, new Date().toISOString());
    await request(leaver, `/files/${kyc.id}`, 409, 'DELETE');
    const adminList = await request(admin, '/files/admin/files?purpose=kyc_document');
    assert.equal(adminList.files[0].original_name, 'Pièce d’identité.png', 'KYC names are masked in admin listings');
  });

  await t.test('deletion: owner (unless evidence), admin with audit, soft delete then purge', async () => {
    const temp = await upload(tester, { purpose: 'message_attachment', resource_type: 'conversation', resource_id: 'conv1' }, 'brouillon.txt', 'à supprimer');
    const key = service.fileRow(temp.id)!.storage_key;
    await request(owner, `/files/${temp.id}`, 403, 'DELETE');
    await request(outsider, `/files/${temp.id}`, 404, 'DELETE');
    await request(tester, `/files/${temp.id}`, 204, 'DELETE');
    const row = service.fileRow(temp.id)!;
    assert.ok(row.deleted_at && row.purged_at);
    assert.equal(row.deleted_by, tester.id);
    assert.equal(existsSync(objectPath(key)), false);
    await request(tester, `/files/${temp.id}`, 404);
    assert.equal(service.getFile(temp.id), null);

    run("UPDATE orders SET status='delivered' WHERE id='o1'");
    await request(seller, `/files/${fixtures.delivery.id}`, 409, 'DELETE');
    run("UPDATE orders SET status='paid' WHERE id='o1'");

    const victim = await upload(outsider, { purpose: 'message_attachment' }, 'spam.txt', 'spam');
    await request(admin, `/files/${victim.id}`, 204, 'DELETE');
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='files.delete' AND target_id=? AND actor_id=?", victim.id, admin.id));
  });

  let cleanFile: Json = {};

  await t.test('antivirus: EICAR via clamd INSTREAM is quarantined, owner and admins notified', async () => {
    await request(tester, '/files/admin/settings', 403, 'PUT', { require_scan: true });
    await request(admin, '/files/admin/settings', 200, 'PUT', { clamav: { enabled: true, host: '127.0.0.1', port: clamdPort, timeout_ms: 5000 } });
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='files.settings' AND actor_id=?", admin.id));

    const infected = await upload(tester, { purpose: 'message_attachment', resource_type: 'conversation', resource_id: 'conv1' }, 'eicar.txt', EICAR);
    assert.equal(infected.scan_status, 'pending');
    assert.equal(infected.available, false);
    await settleScans();
    const row = service.fileRow(infected.id)!;
    assert.equal(row.scan_status, 'infected');
    assert.equal(row.scan_detail, 'Eicar-Test-Signature');
    assert.ok(row.quarantined_at && row.purged_at, 'quarantined: content deleted, metadata kept');
    assert.equal(existsSync(objectPath(row.storage_key)), false);
    assert.deepEqual(clamd.state.lastContent, Buffer.from(EICAR, 'latin1'), 'clamd receives the decrypted plaintext');
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND kind='files.quarantined'", tester.id));
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND kind='files.quarantined_admin' AND link='/admin/files'", admin.id));
    const metadata = await request(tester, `/files/${infected.id}`);
    assert.equal(metadata.quarantined, true);
    assert.match(metadata.unavailable_reason, /quarantaine/);
    const blocked = await download(tester, infected.id);
    assert.equal(blocked.status, 410);
    assert.match((await blocked.json()).error, /quarantaine/);
    assert.equal((await download(admin, infected.id)).status, 410);
    await assert.rejects(service.readFileBuffer(infected.id), /quarantaine/);
    assert.throws(() => service.attachFile(infected.id, tester.id, 'conversation', 'conv1'));

    cleanFile = await upload(tester, { purpose: 'message_attachment', resource_type: 'conversation', resource_id: 'conv1' }, 'propre.txt', 'Aucun virus ici');
    assert.equal(cleanFile.scan_status, 'pending');
    assert.equal((await download(owner, cleanFile.id)).status, 409, 'downloads wait for the scan');
    await settleScans();
    assert.equal(service.getFile(cleanFile.id)!.scan_status, 'clean');
    const ok = await download(owner, cleanFile.id);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'Aucun virus ici');

    // Large builds are streamed to clamd in bounded chunks.
    const bigBuild = await upload(owner, { purpose: 'campaign_build', resource_type: 'campaign', resource_id: 'c1' }, 'gros-build.zip', build);
    await settleScans();
    assert.equal(service.getFile(bigBuild.id)!.scan_status, 'clean');
    assert.deepEqual(clamd.state.lastContent, build);
    assert.ok(clamd.state.chunkSizes.every((size) => size <= 64 * 1024));

    const test = await request(admin, '/files/admin/clamav/test', 200, 'POST', {});
    assert.equal(test.ok, true);
    assert.equal(test.ping, true);
    assert.match(test.version, /ClamAV/);
    assert.equal(test.verdict.signature, 'Eicar-Test-Signature');
    const rescanned = await request(admin, `/files/admin/files/${cleanFile.id}/rescan`, 200, 'POST', {});
    assert.equal(rescanned.scan_status, 'clean');
    await request(admin, `/files/admin/files/${infected.id}/rescan`, 409, 'POST', {});
    const list = await request(admin, '/files/admin/files?scan_status=infected&state=all');
    assert.deepEqual(list.files.map((file: Json) => file.id), [infected.id]);

    assert.deepEqual(parseClamdReply('stream: OK\0'), { status: 'clean', raw: 'stream: OK' });
    assert.equal(parseClamdReply('1: stream: Win.Test.EICAR_HDB-1 FOUND\0').status, 'infected');
    assert.equal(parseClamdReply('INSTREAM size limit exceeded. ERROR\0').status, 'error');
  });

  await t.test('scanner down: file stays pending, files.scan job retries until clean', async () => {
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise<void>((done) => closed.close(() => done()));
    await request(admin, '/files/admin/settings', 200, 'PUT', { clamav: { enabled: true, host: '127.0.0.1', port: closedPort, timeout_ms: 2000 } });
    const unavailable = await request(admin, '/files/admin/clamav/test', 502, 'POST', {});
    assert.match(unavailable.error, /injoignable/);

    const waiting = await upload(tester, { purpose: 'message_attachment', resource_type: 'conversation', resource_id: 'conv1' }, 'attente.txt', 'en attente');
    await settleScans();
    let row = service.fileRow(waiting.id)!;
    assert.equal(row.scan_status, 'pending');
    assert.equal(row.scan_attempts, 1);
    assert.ok(row.next_scan_at && row.next_scan_at > new Date().toISOString(), 'retry scheduled with backoff');
    assert.match(row.scan_detail, /indisponible/);
    assert.equal((await download(owner, waiting.id)).status, 409);

    await runJob('files.scan');
    assert.equal(service.fileRow(waiting.id)!.scan_attempts, 1, 'backoff respected');

    await request(admin, '/files/admin/settings', 200, 'PUT', { clamav: { enabled: true, host: '127.0.0.1', port: clamdPort, timeout_ms: 5000 } });
    run('UPDATE files SET next_scan_at=? WHERE id=?', ago(1000), waiting.id);
    assert.equal(await runJob('files.scan'), true);
    row = service.fileRow(waiting.id)!;
    assert.equal(row.scan_status, 'clean');
    assert.equal(row.next_scan_at, null);
    assert.equal((await download(owner, waiting.id)).status, 200);
  });

  await t.test('require_scan gates unscanned files; manual quarantine by an admin', async () => {
    await request(admin, '/files/admin/settings', 200, 'PUT', { clamav: { enabled: false, host: '127.0.0.1', port: clamdPort, timeout_ms: 5000 }, require_scan: true });
    assert.equal((await download(owner, fixtures.message.id)).status, 409, 'skipped files need a scan once scanning is required');
    const queued = await upload(tester, { purpose: 'message_attachment' }, 'requis.txt', 'scan requis');
    assert.equal(queued.scan_status, 'pending');
    await settleScans();
    assert.equal(service.getFile(queued.id)!.scan_status, 'pending');
    assert.equal((await service.readFileBuffer(fixtures.export.id)).length > 0, true, 'internal content stays readable');
    await request(admin, '/files/admin/settings', 200, 'PUT', { require_scan: false });
    await runJob('files.scan');
    assert.equal(service.getFile(queued.id)!.scan_status, 'skipped');
    assert.equal((await download(owner, fixtures.message.id)).status, 200);

    await request(admin, `/files/admin/files/${fixtures.message.id}/quarantine`, 400, 'POST', {});
    const quarantined = await request(admin, `/files/admin/files/${fixtures.message.id}/quarantine`, 200, 'POST', { reason: 'Signalement utilisateur' });
    assert.equal(quarantined.quarantined, true);
    assert.equal(quarantined.scan_status, 'infected');
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND kind='files.quarantined' AND body LIKE '%log.txt%'", tester.id));
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='files.quarantine' AND target_id=?", fixtures.message.id));
    assert.equal((await download(owner, fixtures.message.id)).status, 410);

    const overview = await request(admin, '/files/admin/overview');
    assert.ok(overview.totals.quarantined >= 2);
    assert.equal(overview.scanner.configured, false);
    assert.equal(overview.require_scan, false);
    assert.ok(overview.stats.some((row: Json) => row.purpose === 'campaign_build'));
    assert.equal(overview.encryption.files_with_previous_key, 0);
    await request(owner, '/files/admin/overview', 403);
    await request(admin, '/files/admin/settings', 400, 'PUT', { clamav: { enabled: true, host: 'bad host;rm', port: 3310, timeout_ms: 5000 } });
    await request(admin, '/files/admin/settings', 400, 'PUT', { policies: { message_attachment: { kinds: ['svg'] } } });
  });

  await t.test('files.cleanup job: retention, physical purge, temp files and orphans', async () => {
    const loose = await upload(outsider, { purpose: 'message_attachment' }, 'oublie.txt', 'oublié');
    const recent = await upload(outsider, { purpose: 'message_attachment' }, 'recent.txt', 'récent');
    const kycDraft = await upload(outsider, { purpose: 'kyc_document' }, 'cni.pdf', pdf('cni'));
    const kycOld = await upload(outsider, { purpose: 'kyc_document' }, 'ancienne-cni.pdf', pdf('old'));
    const kycExpired = await upload(outsider, { purpose: 'kyc_document', resource_type: 'kyc', resource_id: outsider.id }, 'expiree.pdf', pdf('exp'));
    const exportOld = await service.storeBuffer({ ownerId: outsider.id, purpose: 'privacy_export', name: 'export.zip', mimeType: 'application/zip', data: zip('e'), skipScan: true });
    run('UPDATE files SET created_at=? WHERE id IN (?,?)', ago(2 * DAY), loose.id, kycDraft.id);
    run('UPDATE files SET created_at=? WHERE id=?', ago(31 * DAY), kycOld.id);
    run('UPDATE files SET created_at=? WHERE id=?', ago(8 * DAY), exportOld.id);
    run('UPDATE files SET retain_until=? WHERE id=?', ago(DAY), kycExpired.id);
    const tmp = join(filesRoot, 'tmp');
    const staleTemp = join(tmp, `${'a'.repeat(32)}.part`);
    writeFileSync(staleTemp, 'x');
    utimesSync(staleTemp, new Date(Date.now() - 2 * 3600000), new Date(Date.now() - 2 * 3600000));
    const freshTemp = join(tmp, `${'b'.repeat(32)}.part`);
    writeFileSync(freshTemp, 'x');
    const orphanDir = join(filesRoot, 'objects', 'ab');
    mkdirSync(orphanDir, { recursive: true, mode: 0o700 });
    chmodSync(orphanDir, 0o700);
    const orphan = join(orphanDir, `ab${'0'.repeat(38)}`);
    writeFileSync(orphan, 'orphelin');
    utimesSync(orphan, new Date(Date.now() - 7 * 3600000), new Date(Date.now() - 7 * 3600000));
    const looseKey = service.fileRow(loose.id)!.storage_key;

    assert.equal(await runJob('files.cleanup'), true);
    const state = (fileId: string) => service.fileRow(fileId)!;
    assert.ok(state(loose.id).deleted_at && state(loose.id).purged_at, 'unattached upload older than 24 h');
    assert.equal(existsSync(objectPath(looseKey)), false);
    assert.equal(state(recent.id).deleted_at, null);
    assert.equal(state(kycDraft.id).deleted_at, null, 'KYC drafts are kept 30 days');
    assert.ok(state(kycOld.id).deleted_at);
    assert.ok(state(exportOld.id).deleted_at && state(exportOld.id).purged_at, 'privacy exports expire after 7 days');
    assert.ok(state(kycExpired.id).deleted_at, 'KYC past its legal retention');
    assert.ok(state(fixtures.message.id).purged_at, 'quarantined content stays purged');
    assert.equal(existsSync(staleTemp), false);
    assert.equal(existsSync(freshTemp), true);
    assert.equal(existsSync(orphan), false);
    assert.ok(existsSync(objectPath(state(buildFile.id).storage_key)), 'attached files are untouched');
    writeFileSync(freshTemp, '');
    rmSync(freshTemp);
  });

  await t.test('GDPR: export metadata, erase keeps legally retained KYC and disowns delivered files', async () => {
    run("INSERT INTO listings(id,seller_id,title,description,kind,price_cents,license,deliverables) VALUES ('l2',?,'Pack','Desc','software',500,'MIT','Code')", leaver.id);
    run("INSERT INTO orders(id,listing_id,buyer_id,seller_id,price_cents,status) VALUES ('o3','l2',?,?,500,'paid')", buyer.id, leaver.id);
    const delivered = await upload(leaver, { purpose: 'listing_delivery', resource_type: 'order', resource_id: 'o3' }, 'pack.zip', zip('pack'));
    run("UPDATE orders SET status='delivered' WHERE id='o3'");
    const personal = await upload(leaver, { purpose: 'message_attachment' }, 'Jean Dupont - CV.pdf', pdf('cv'));
    const handler = personalDataHandlers().find(([name]) => name === 'files')![1];
    const exported = handler.export(leaver.id) as Json;
    assert.deepEqual(exported.files.map((file: Json) => file.id).sort(), [fixtures.kyc.id, fixtures.kycUnsent.id, delivered.id, personal.id].sort());
    assert.equal(exported.kyc_admin_access.length, 4);
    assert.ok(!JSON.stringify(exported).includes('storage_key'));

    transaction(() => handler.erase(leaver.id));
    const kyc = service.fileRow(fixtures.kyc.id)!;
    assert.equal(kyc.deleted_at, null);
    assert.equal(kyc.owner_id, leaver.id);
    assert.ok(kyc.retain_until && kyc.retain_until > new Date(Date.now() + 4 * 365 * DAY).toISOString(), 'KYC retained 5 years');
    const deliveredRow = service.fileRow(delivered.id)!;
    assert.equal(deliveredRow.owner_id, null);
    assert.equal(deliveredRow.deleted_at, null);
    assert.equal((await download(buyer, delivered.id)).status, 200, 'buyer keeps the delivered file');
    const personalRow = service.fileRow(personal.id)!;
    assert.ok(personalRow.deleted_at);
    assert.equal(personalRow.original_name, 'fichier-supprime.pdf');
  });
});
