type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const secretKey = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|private|signature/i;

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'warn' : 'info')) as Level;
  return order[configured] ?? order.info;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]';
  if (value instanceof Error) return { name: value.name, message: value.message, stack: process.env.NODE_ENV === 'production' ? undefined : value.stack };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  }
  return value;
}

function write(level: Level, message: string, fields: Fields = {}) {
  if (order[level] < threshold()) return;
  const entry = { time: new Date().toISOString(), level, msg: message, ...(redact(fields) as Fields) };
  const line = process.env.LOG_FORMAT === 'pretty' || (process.env.NODE_ENV !== 'production' && process.env.LOG_FORMAT !== 'json')
    ? `[${entry.time}] ${level.toUpperCase()} ${message}${Object.keys(fields).length ? ` ${JSON.stringify(redact(fields))}` : ''}`
    : JSON.stringify(entry);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  debug: (message: string, fields?: Fields) => write('debug', message, fields),
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};
