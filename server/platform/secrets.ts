import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Key { id: string; material: Buffer }

function parseKey(raw: string, source: string): Buffer {
  const value = raw.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new Error(`${source} doit contenir 32 octets (64 caracteres hexadecimaux ou base64).`);
  return decoded;
}

function toKey(material: Buffer): Key {
  return { id: createHash('sha256').update(material).digest('hex').slice(0, 12), material };
}

function developmentKey(): Buffer {
  const database = process.env.DATABASE_PATH ?? './data/alpha.sqlite';
  if (database === ':memory:') return randomBytes(32);
  const file = join(dirname(database), '.alpha-secrets.key');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    try { writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  chmodSync(file, 0o600);
  return parseKey(readFileSync(file, 'utf8'), file);
}

let keys: Key[] | undefined;
function keyring(): Key[] {
  if (keys) return keys;
  const configured = process.env.ALPHA_SECRETS_KEY;
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('ALPHA_SECRETS_KEY est requis en production.');
  const current = toKey(configured ? parseKey(configured, 'ALPHA_SECRETS_KEY') : developmentKey());
  const previous = (process.env.ALPHA_SECRETS_KEY_PREVIOUS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    .map((item) => toKey(parseKey(item, 'ALPHA_SECRETS_KEY_PREVIOUS')));
  keys = [current, ...previous];
  return keys;
}

/** Validates the configured key early (called at startup). */
export function assertSecretsReady() { keyring(); }

/** AES-256-GCM. `context` is bound as AAD so a sealed value cannot be replayed under another setting or row. */
export function seal(plaintext: string, context: string): string {
  const [key] = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.material, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', key.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function unseal(sealed: string, context: string): string {
  const [version, keyId, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !keyId || !iv || !tag || body === undefined) throw new Error('Secret chiffre invalide.');
  const key = keyring().find((item) => item.id === keyId);
  if (!key) throw new Error('Cle de dechiffrement inconnue. Verifiez ALPHA_SECRETS_KEY / ALPHA_SECRETS_KEY_PREVIOUS.');
  const decipher = createDecipheriv('aes-256-gcm', key.material, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/** Binary variant for encrypted file storage: 12-byte key id + 12-byte IV + 16-byte tag + ciphertext. */
export function sealBuffer(data: Buffer, context: string): Buffer {
  const [key] = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.material, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from(key.id, 'ascii'), iv, cipher.getAuthTag(), body]);
}

export function unsealBuffer(data: Buffer, context: string): Buffer {
  const keyId = data.subarray(0, 12).toString('ascii');
  const key = keyring().find((item) => item.id === keyId);
  if (!key) throw new Error('Cle de dechiffrement inconnue.');
  const decipher = createDecipheriv('aes-256-gcm', key.material, data.subarray(12, 24));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(24, 40));
  return Buffer.concat([decipher.update(data.subarray(40)), decipher.final()]);
}

/** Keyed hash for privacy-preserving identifiers (IP, user agent, phone). Not reversible without the key. */
export function keyedHash(value: string, purpose: string): string {
  const [key] = keyring();
  return createHmac('sha256', key.material).update(`${purpose}\u0000${value}`).digest('hex');
}

export function hmacHex(secret: string | Buffer, payload: string | Buffer, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
  return createHmac(algorithm, secret).update(payload).digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
export function sha256Hex(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

export function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}
