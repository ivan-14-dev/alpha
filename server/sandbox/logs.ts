/**
 * Bounded log capture. Keeps the beginning AND the end of the output (the end usually holds the failure), never more
 * than `capBytes` in total, plus an optional larger head-only copy for the downloadable artifact.
 */
export const LOG_CAP_BYTES = 256 * 1024;
export const ARTIFACT_CAP_BYTES = 4 * 1024 * 1024;
const MARKER_RESERVE = 128;

// ANSI escapes and control characters (except tab/newline) are stripped: logs are rendered as plain text.
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function sanitizeLog(text: string, redactions: string[] = []): string {
  let value = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(ansi, '').replace(controls, '');
  for (const secret of redactions) if (secret.length >= 4) value = value.split(secret).join('[masqué]');
  return value;
}

export class LogCollector {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private full: Buffer[] = [];
  private fullBytes = 0;
  total = 0;
  version = 0;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(private readonly capBytes = LOG_CAP_BYTES, private readonly artifactCap = 0, private readonly redactions: string[] = []) {
    this.tailCap = Math.floor(capBytes / 4);
    this.headCap = capBytes - this.tailCap - MARKER_RESERVE;
  }

  push(chunk: Buffer) {
    if (!chunk.length) return;
    this.total += chunk.length;
    this.version += 1;
    if (this.fullBytes < this.artifactCap) {
      const part = chunk.subarray(0, this.artifactCap - this.fullBytes);
      this.full.push(part);
      this.fullBytes += part.length;
    }
    let rest = chunk;
    if (this.headBytes < this.headCap) {
      const part = rest.subarray(0, this.headCap - this.headBytes);
      this.head.push(part);
      this.headBytes += part.length;
      rest = rest.subarray(part.length);
    }
    if (!rest.length) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > this.tailCap) {
      const first = this.tail[0];
      const excess = this.tailBytes - this.tailCap;
      if (first.length <= excess) { this.tail.shift(); this.tailBytes -= first.length; }
      else { this.tail[0] = first.subarray(excess); this.tailBytes -= excess; }
    }
  }

  get truncated(): boolean { return this.total > this.headBytes + this.tailBytes; }

  /** Text stored in the database: always <= capBytes characters. */
  text(): string {
    const head = sanitizeLog(Buffer.concat(this.head).toString('utf8'), this.redactions);
    const tail = sanitizeLog(Buffer.concat(this.tail).toString('utf8'), this.redactions);
    const omitted = this.total - this.headBytes - this.tailBytes;
    const value = omitted > 0 ? `${head}\n[… ${omitted} octets omis : journal limité à ${Math.round(this.capBytes / 1024)} Ko …]\n${tail}` : head + tail;
    return value.slice(0, this.capBytes);
  }

  /** Larger head-only copy, only meaningful when the stored text was truncated. */
  artifact(): Buffer | null {
    if (!this.artifactCap || !this.truncated) return null;
    return Buffer.from(sanitizeLog(Buffer.concat(this.full).toString('utf8'), this.redactions), 'utf8');
  }

  /** Lines produced by the platform itself (clearly prefixed so they cannot be confused with program output). */
  note(message: string) { this.push(Buffer.from(`[alpha-sandbox] ${message}\n`, 'utf8')); }
}
