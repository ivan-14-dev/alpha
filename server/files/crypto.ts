import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { keyedHash } from '../platform/secrets.js';

/**
 * Encryption at rest for stored files: segmented AES-256-GCM ("STREAM" construction).
 *
 * Layout: header(32) = "ALF" 0x01 | key fingerprint (16 ASCII hex) | nonce prefix (7) | reserved (1) | segment size (uint32 BE)
 *         then N segments = ciphertext (<= segment size) + GCM tag (16).
 * Nonce(i) = prefix(7) | uint32BE(i) | last-segment flag (1). AAD = header | "file:<fileId>".
 * Every segment is authenticated before its plaintext is released (no unauthenticated bytes reach a download),
 * and truncation, reordering or swapping files between rows are detected.
 *
 * Per-file key = HMAC-SHA256(platform master key, "file-encryption\0<fileId>") (secrets.keyedHash), so the database
 * never stores file keys. Rotation: files written with a previous master key stay readable as long as that key is
 * listed in ALPHA_SECRETS_KEY_PREVIOUS; the `files.rekey` job re-encrypts them with the current key.
 */
export const HEADER_LENGTH = 32;
export const TAG_LENGTH = 16;
export const SEGMENT_SIZE = 64 * 1024;
const MAGIC = Buffer.from([0x41, 0x4c, 0x46, 0x01]);
const KEY_PURPOSE = 'file-encryption';
const FINGERPRINT_PURPOSE = 'file-encryption-key';

interface MasterKey { fingerprint: string; fileKey: (fileId: string) => Buffer }

function parseMaterial(raw: string): Buffer | null {
  const value = raw.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded : null;
}

/** Same derivation as secrets.keyedHash, for keys listed in ALPHA_SECRETS_KEY_PREVIOUS. */
function previousKeys(): MasterKey[] {
  return (process.env.ALPHA_SECRETS_KEY_PREVIOUS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    .map(parseMaterial).filter((material): material is Buffer => !!material)
    .map((material) => ({
      fingerprint: createHmac('sha256', material).update(`${FINGERPRINT_PURPOSE}\u0000fingerprint`).digest('hex').slice(0, 16),
      fileKey: (fileId: string) => createHmac('sha256', material).update(`${KEY_PURPOSE}\u0000${fileId}`).digest(),
    }));
}

export function currentKeyFingerprint(): string {
  return keyedHash('fingerprint', FINGERPRINT_PURPOSE).slice(0, 16);
}

function currentKey(): MasterKey {
  return { fingerprint: currentKeyFingerprint(), fileKey: (fileId) => Buffer.from(keyedHash(fileId, KEY_PURPOSE), 'hex') };
}

function keyForFingerprint(fingerprint: string): MasterKey {
  const current = currentKey();
  if (current.fingerprint === fingerprint) return current;
  const previous = previousKeys().find((key) => key.fingerprint === fingerprint);
  if (!previous) throw new FileCryptoError('Clé de chiffrement du fichier inconnue. Ajoutez l’ancienne clé à ALPHA_SECRETS_KEY_PREVIOUS.');
  return previous;
}

export class FileCryptoError extends Error {}

function nonce(prefix: Buffer, index: number, last: boolean): Buffer {
  const value = Buffer.alloc(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(index, 7);
  value[11] = last ? 1 : 0;
  return value;
}

function aad(header: Buffer, fileId: string) { return Buffer.concat([header, Buffer.from(`file:${fileId}`, 'utf8')]); }

/** Encrypts a plaintext stream for `fileId` with the current master key. */
export class EncryptStream extends Transform {
  readonly fingerprint: string;
  private readonly key: Buffer;
  private readonly header: Buffer;
  private readonly prefix = randomBytes(7);
  private readonly aad: Buffer;
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private index = 0;

  constructor(fileId: string, private readonly segmentSize = SEGMENT_SIZE) {
    super();
    const master = currentKey();
    this.fingerprint = master.fingerprint;
    this.key = master.fileKey(fileId);
    this.header = Buffer.alloc(HEADER_LENGTH);
    MAGIC.copy(this.header, 0);
    this.header.write(master.fingerprint, 4, 16, 'ascii');
    this.prefix.copy(this.header, 20);
    this.header.writeUInt32BE(segmentSize, 28);
    this.aad = aad(this.header, fileId);
    this.push(this.header);
  }

  private seal(plaintext: Buffer, last: boolean) {
    if (this.index >= 0xffffffff) throw new FileCryptoError('Fichier trop volumineux pour le chiffrement.');
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.index, last));
    cipher.setAAD(this.aad);
    this.push(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
    this.index += 1;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      this.pending.push(chunk);
      this.pendingLength += chunk.length;
      // Keep at least one byte buffered: only flush() knows which segment is the last one.
      if (this.pendingLength > this.segmentSize) {
        const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
        let offset = 0;
        while (all.length - offset > this.segmentSize) {
          this.seal(all.subarray(offset, offset + this.segmentSize), false);
          offset += this.segmentSize;
        }
        const rest = Buffer.from(all.subarray(offset));
        this.pending = [rest];
        this.pendingLength = rest.length;
      }
      callback();
    } catch (error) { callback(error as Error); }
  }

  override _flush(callback: TransformCallback) {
    try {
      this.seal(Buffer.concat(this.pending), true);
      this.pending = [];
      callback();
    } catch (error) { callback(error as Error); }
  }
}

/** Decrypts and authenticates every segment before releasing it. */
export class DecryptStream extends Transform {
  private key: Buffer | null = null;
  private header: Buffer | null = null;
  private aad: Buffer | null = null;
  private prefix: Buffer | null = null;
  private segmentSize = 0;
  private pending: Buffer = Buffer.alloc(0);
  private index = 0;
  fingerprint = '';

  constructor(private readonly fileId: string) { super(); }

  private open(header: Buffer) {
    if (!header.subarray(0, 4).equals(MAGIC)) throw new FileCryptoError('Format de fichier chiffré inconnu.');
    this.fingerprint = header.subarray(4, 20).toString('ascii');
    this.key = keyForFingerprint(this.fingerprint).fileKey(this.fileId);
    this.prefix = header.subarray(20, 27);
    this.segmentSize = header.readUInt32BE(28);
    if (this.segmentSize < 1024 || this.segmentSize > 16 * 1024 * 1024) throw new FileCryptoError('En-tête de fichier chiffré invalide.');
    this.header = header;
    this.aad = aad(header, this.fileId);
  }

  private openSegment(segment: Buffer, last: boolean): Buffer {
    if (segment.length < TAG_LENGTH) throw new FileCryptoError('Fichier chiffré tronqué.');
    const decipher = createDecipheriv('aes-256-gcm', this.key!, nonce(this.prefix!, this.index, last));
    decipher.setAAD(this.aad!);
    decipher.setAuthTag(segment.subarray(segment.length - TAG_LENGTH));
    try {
      const plaintext = Buffer.concat([decipher.update(segment.subarray(0, segment.length - TAG_LENGTH)), decipher.final()]);
      this.index += 1;
      return plaintext;
    } catch {
      throw new FileCryptoError('Intégrité du fichier compromise : le contenu chiffré a été modifié ou tronqué.');
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      if (!this.header) {
        if (this.pending.length < HEADER_LENGTH) return callback();
        this.open(Buffer.from(this.pending.subarray(0, HEADER_LENGTH)));
        this.pending = this.pending.subarray(HEADER_LENGTH);
      }
      const sealedSize = this.segmentSize + TAG_LENGTH;
      while (this.pending.length > sealedSize) {
        this.push(this.openSegment(this.pending.subarray(0, sealedSize), false));
        this.pending = this.pending.subarray(sealedSize);
      }
      callback();
    } catch (error) { callback(error as Error); }
  }

  override _flush(callback: TransformCallback) {
    try {
      if (!this.header) throw new FileCryptoError('Fichier chiffré tronqué.');
      this.push(this.openSegment(this.pending, true));
      callback();
    } catch (error) { callback(error as Error); }
  }
}

/** Size on disk of an encrypted file holding `plaintextBytes`. */
export function encryptedSize(plaintextBytes: number, segmentSize = SEGMENT_SIZE): number {
  const segments = Math.max(1, Math.ceil(plaintextBytes / segmentSize));
  return HEADER_LENGTH + plaintextBytes + segments * TAG_LENGTH;
}
