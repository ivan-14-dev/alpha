import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Minimal clamd client (TCP). INSTREAM protocol: "zINSTREAM\0", then chunks prefixed by their length
 * (4-byte unsigned big-endian), terminated by a zero-length chunk. clamd answers "stream: OK" or
 * "stream: <signature> FOUND" (or "... ERROR"), NUL-terminated because of the "z" command prefix.
 */
export interface ClamdConfig { host: string; port: number; timeoutMs: number }
export type ClamdVerdict =
  | { status: 'clean'; raw: string }
  | { status: 'infected'; signature: string; raw: string }
  | { status: 'error'; detail: string; raw: string };

/** Network failure, refused connection or timeout: the file stays pending and is retried later. */
export class ScannerUnavailableError extends Error {}

const CHUNK = 64 * 1024;

export function parseClamdReply(reply: string): ClamdVerdict {
  const raw = reply.replace(/\0/g, '').trim();
  const body = raw.replace(/^(\d+: )?stream: ?/i, '');
  if (/^OK$/i.test(body)) return { status: 'clean', raw };
  const found = /^(.+?) FOUND$/i.exec(body);
  if (found) return { status: 'infected', signature: found[1].trim().slice(0, 200), raw };
  return { status: 'error', detail: (body || 'Réponse vide de clamd').slice(0, 300), raw };
}

function waitWritable(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { socket.off('drain', finish); socket.off('close', finish); resolve(); };
    socket.once('drain', finish);
    socket.once('close', finish);
  });
}

function session(config: ClamdConfig, onConnect: (socket: Socket) => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let reply = Buffer.alloc(0);
    const socket = connect({ host: config.host, port: config.port });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error && !reply.length) reject(error);
      else resolve(reply.toString('utf8'));
    };
    socket.setTimeout(config.timeoutMs, () => finish(new ScannerUnavailableError(`clamd ne répond pas (délai de ${config.timeoutMs} ms dépassé).`)));
    socket.on('error', (error) => finish(new ScannerUnavailableError(`clamd injoignable : ${(error as NodeJS.ErrnoException).code ?? error.message}`)));
    socket.on('data', (data: Buffer) => {
      reply = Buffer.concat([reply, data]);
      if (reply.includes(0)) finish();
      else if (reply.length > 4096) finish();
    });
    socket.on('end', () => finish(new ScannerUnavailableError('clamd a fermé la connexion sans réponse.')));
    socket.on('close', () => finish(new ScannerUnavailableError('clamd a fermé la connexion sans réponse.')));
    socket.on('connect', () => {
      onConnect(socket).catch((error: Error) => {
        // Source failures (e.g. decryption integrity errors) are not scanner outages.
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      });
    });
  });
}

/** Streams `source` to clamd and returns its verdict. */
export async function clamdScan(config: ClamdConfig, source: Readable | Buffer): Promise<ClamdVerdict> {
  const reply = await session(config, async (socket) => {
    socket.write('zINSTREAM\0');
    const chunks: AsyncIterable<Buffer> | Buffer[] = Buffer.isBuffer(source) ? [source] : source as AsyncIterable<Buffer>;
    try {
      for await (const chunk of chunks) {
        for (let offset = 0; offset < chunk.length; offset += CHUNK) {
          if (socket.destroyed) return;
          const part = chunk.subarray(offset, offset + CHUNK);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(part.length, 0);
          socket.write(length);
          if (!socket.write(part)) await waitWritable(socket);
        }
      }
      if (!socket.destroyed) socket.write(Buffer.alloc(4));
    } finally {
      if (!Buffer.isBuffer(source)) (source as Readable).destroy();
    }
  });
  return parseClamdReply(reply);
}

export async function clamdPing(config: ClamdConfig): Promise<boolean> {
  const reply = await session(config, async (socket) => { socket.write('zPING\0'); });
  return reply.replace(/\0/g, '').trim() === 'PONG';
}

export async function clamdVersion(config: ClamdConfig): Promise<string> {
  const reply = await session(config, async (socket) => { socket.write('zVERSION\0'); });
  return reply.replace(/\0/g, '').trim().slice(0, 200);
}

/** The standard antivirus test string, assembled at runtime so source files are not flagged themselves. */
export function eicarTestString(): string {
  return ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');
}
