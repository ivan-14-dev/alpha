import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, EncryptStream } from './crypto.js';

/**
 * Private on-disk storage. Paths are always derived from random storage keys (never from user input),
 * directories are 0700 and files 0600. Content is encrypted before it touches the disk.
 */
let configured: string | null = null;
let ephemeral = false;

export function filesDir(): string {
  if (configured) return configured;
  const database = process.env.DATABASE_PATH ?? './data/alpha.sqlite';
  if (process.env.FILES_DIR) configured = resolve(process.env.FILES_DIR);
  else if (database === ':memory:') {
    configured = join(tmpdir(), `alpha-files-${process.pid}`);
    ephemeral = true;
    process.once('exit', () => { try { rmSync(configured!, { recursive: true, force: true }); } catch { /* best effort */ } });
  } else configured = resolve(dirname(database), 'files');
  return configured;
}

/** Test helper: forget the resolved directory (FILES_DIR is re-read on next use). */
export function resetFilesDirForTests() { configured = null; ephemeral = false; }
export function filesDirIsEphemeral() { filesDir(); return ephemeral; }

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

const ensured = new Set<string>();
function privateDir(...parts: string[]): string {
  const path = join(filesDir(), ...parts);
  if (!ensured.has(path) || !existsSync(path)) {
    ensureDir(filesDir());
    ensureDir(path);
    ensured.add(path);
  }
  return path;
}

const storageKeyPattern = /^[a-f0-9]{40}$/;
export function newStorageKey(): string { return randomBytes(20).toString('hex'); }

export function objectPath(storageKey: string): string {
  if (!storageKeyPattern.test(storageKey)) throw new Error('Clé de stockage invalide.');
  return join(privateDir('objects', storageKey.slice(0, 2)), storageKey);
}

export function tempPath(): string {
  return join(privateDir('tmp'), `${randomBytes(16).toString('hex')}.part`);
}

export function tempDir(): string { return privateDir('tmp'); }

export function objectExists(storageKey: string): boolean {
  try { return existsSync(objectPath(storageKey)); } catch { return false; }
}

/** Atomically moves a finished temp file into the object store. */
export function commitTemp(temp: string, storageKey: string) {
  const target = objectPath(storageKey);
  renameSync(temp, target);
  chmodSync(target, 0o600);
}

export function removeQuietly(path: string | null | undefined) {
  if (!path) return;
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function removeObject(storageKey: string) { removeQuietly(objectPath(storageKey)); }

export interface PlaintextStats {
  size: number;
  sha256: string;
  /** First 8 KiB of plaintext (magic bytes, markup detection). */
  head: Buffer;
  /** Last 512 bytes of plaintext (DMG trailer). */
  tail: Buffer;
}

export const HEAD_BYTES = 8192;
const TAIL_BYTES = 512;

/** Counts, hashes and samples plaintext; fails with `onLimit()` as soon as `maxBytes` is exceeded. */
export class PlaintextInspector extends Transform {
  size = 0;
  private hash = createHash('sha256');
  private headChunks: Buffer[] = [];
  private headLength = 0;
  private tailBuffer = Buffer.alloc(0);

  constructor(private readonly maxBytes: number, private readonly onLimit: () => Error) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.size += chunk.length;
    if (this.size > this.maxBytes) return callback(this.onLimit());
    this.hash.update(chunk);
    if (this.headLength < HEAD_BYTES) {
      const slice = chunk.subarray(0, HEAD_BYTES - this.headLength);
      this.headChunks.push(Buffer.from(slice));
      this.headLength += slice.length;
    }
    const combined = Buffer.concat([this.tailBuffer, chunk.length > TAIL_BYTES ? chunk.subarray(chunk.length - TAIL_BYTES) : chunk]);
    this.tailBuffer = Buffer.from(combined.subarray(Math.max(0, combined.length - TAIL_BYTES)));
    callback(null, chunk);
  }

  stats(): PlaintextStats {
    return { size: this.size, sha256: this.hash.digest('hex'), head: Buffer.concat(this.headChunks), tail: this.tailBuffer };
  }
}

export interface WrittenObject extends PlaintextStats { temp: string; fingerprint: string }

/** Streams plaintext through inspection + encryption into a 0600 temp file. Caller commits or removes `temp`. */
export async function writeEncryptedTemp(source: Readable, fileId: string, maxBytes: number, onLimit: () => Error): Promise<WrittenObject> {
  const temp = tempPath();
  const inspector = new PlaintextInspector(maxBytes, onLimit);
  const encryptor = new EncryptStream(fileId);
  const sink = createWriteStream(temp, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(source, inspector, encryptor, sink);
    return { ...inspector.stats(), temp, fingerprint: encryptor.fingerprint };
  } catch (error) {
    // The temp file is opened asynchronously: wait for the sink to close so the removal cannot race its creation.
    sink.destroy();
    if (!sink.closed) await new Promise<void>((resolve) => sink.once('close', () => resolve()));
    removeQuietly(temp);
    throw error;
  }
}

/** Decrypted plaintext stream of a stored object. Integrity errors surface as stream errors. */
export function openDecrypted(storageKey: string, fileId: string): Readable {
  const output = new PassThrough();
  pipeline(createReadStream(objectPath(storageKey)), new DecryptStream(fileId), output).catch((error) => output.destroy(error));
  return output;
}

export async function readDecrypted(storageKey: string, fileId: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of openDecrypted(storageKey, fileId)) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new Error('Fichier trop volumineux pour être chargé en mémoire.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Removes abandoned upload temp files older than `maxAgeMs`. Returns the number removed. */
export function purgeTempFiles(maxAgeMs: number): number {
  const dir = join(filesDir(), 'tmp');
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const limit = Date.now() - maxAgeMs;
  for (const name of readdirSync(dir)) {
    if (!/^[a-f0-9]{32}\.part$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < limit) { unlinkSync(path); removed += 1; }
    } catch { /* concurrently removed */ }
  }
  return removed;
}

/** Storage keys present on disk and older than `minAgeMs` (orphan detection by the cleanup job). */
export function listObjectKeys(minAgeMs: number, max = 10000): string[] {
  const root = join(filesDir(), 'objects');
  if (!existsSync(root)) return [];
  const limit = Date.now() - minAgeMs;
  const keys: string[] = [];
  for (const prefix of readdirSync(root)) {
    if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
    for (const name of readdirSync(join(root, prefix))) {
      if (!storageKeyPattern.test(name) || !name.startsWith(prefix)) continue;
      try { if (statSync(join(root, prefix, name)).mtimeMs < limit) keys.push(name); } catch { /* concurrently removed */ }
      if (keys.length >= max) return keys;
    }
  }
  return keys;
}

export function objectSize(storageKey: string): number | null {
  try { return statSync(objectPath(storageKey)).size; } catch { return null; }
}
