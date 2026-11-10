/**
 * In-process Prometheus registry (text exposition format 0.0.4). No external dependency.
 * Labels are bounded: HTTP routes use Express route patterns (never raw URLs) and identifiers are never used as labels.
 */

export type Labels = Record<string, string>;

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** Hard cap on distinct HTTP label sets so a misbehaving client cannot blow up memory. */
const maxSeries = 2000;

interface HistogramSeries { labels: Labels; buckets: number[]; sum: number; count: number }

const requestCounter = new Map<string, { labels: Labels; value: number }>();
const requestDuration = new Map<string, HistogramSeries>();
let inFlight = 0;

function seriesKey(labels: Labels): string {
  return Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join('\u0000');
}

const idSegment = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d+)$/i;

/** Express route pattern for a finished request (e.g. `/api/projects/:id`). Mount points containing concrete ids are masked. */
export function routeLabel(baseUrl: string, routePath: unknown, matched: boolean, url: string): string {
  if (!url.startsWith('/api')) return '(static)';
  if (!matched) return '(unmatched)';
  const pattern = typeof routePath === 'string' ? routePath : Array.isArray(routePath) ? routePath.map(String).join('|') : String(routePath);
  const full = `${baseUrl}${pattern === '/' && baseUrl ? '' : pattern}` || '/';
  return full.split('/').map((segment) => (idSegment.test(segment) ? ':id' : segment)).join('/').slice(0, 120);
}

export function httpRequestStarted() { inFlight += 1; }
export function httpRequestEnded() { inFlight = Math.max(0, inFlight - 1); }

function series<T>(store: Map<string, T>, labels: Labels, create: (labels: Labels) => T): T {
  const key = seriesKey(labels);
  const existing = store.get(key);
  if (existing) return existing;
  // Past the cap, new label sets collapse into a single `(other)` route series.
  const bounded = store.size >= maxSeries && labels.route !== '(other)' ? { ...labels, route: '(other)' } : labels;
  const boundedKey = seriesKey(bounded);
  const created = store.get(boundedKey) ?? create(bounded);
  store.set(boundedKey, created);
  return created;
}

export function recordHttpRequest(method: string, route: string, status: number, durationSeconds: number) {
  const normalizedMethod = /^[A-Z]{3,7}$/.test(method) ? method : 'OTHER';
  const counter = series(requestCounter, { method: normalizedMethod, route, status: String(status) }, (labels) => ({ labels, value: 0 }));
  counter.value += 1;
  const histogram = series(requestDuration, { method: normalizedMethod, route },
    (labels) => ({ labels, buckets: durationBuckets.map(() => 0), sum: 0, count: 0 }));
  durationBuckets.forEach((bound, index) => { if (durationSeconds <= bound) histogram.buckets[index] += 1; });
  histogram.sum += durationSeconds;
  histogram.count += 1;
}

/** Tests only. */
export function resetHttpMetrics() {
  requestCounter.clear();
  requestDuration.clear();
  inFlight = 0;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}` : '';
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

/** Builder for one exposition document; each metric family is written once with HELP/TYPE. */
export class MetricsWriter {
  private lines: string[] = [];

  family(name: string, type: 'counter' | 'gauge' | 'histogram', help: string, samples: Array<{ labels?: Labels; value: number }>) {
    this.lines.push(`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${name} ${type}`);
    for (const sample of samples) this.lines.push(`${name}${formatLabels(sample.labels ?? {})} ${formatValue(sample.value)}`);
  }

  gauge(name: string, help: string, value: number, labels?: Labels) { this.family(name, 'gauge', help, [{ labels, value }]); }

  toString() { return `${this.lines.join('\n')}\n`; }

  /** Appends the HTTP metrics collected by the observability middleware. */
  http() {
    this.family('alpha_http_requests_total', 'counter', 'HTTP requests handled, by method, route pattern and status.',
      [...requestCounter.values()].map((series) => ({ labels: series.labels, value: series.value })));
    this.lines.push('# HELP alpha_http_request_duration_seconds HTTP request handling duration.', '# TYPE alpha_http_request_duration_seconds histogram');
    for (const series of requestDuration.values()) {
      durationBuckets.forEach((bound, index) => {
        this.lines.push(`alpha_http_request_duration_seconds_bucket${formatLabels({ ...series.labels, le: String(bound) })} ${series.buckets[index]}`);
      });
      this.lines.push(`alpha_http_request_duration_seconds_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
      this.lines.push(`alpha_http_request_duration_seconds_sum${formatLabels(series.labels)} ${series.sum}`);
      this.lines.push(`alpha_http_request_duration_seconds_count${formatLabels(series.labels)} ${series.count}`);
    }
    this.gauge('alpha_http_requests_in_flight', 'HTTP requests in progress (including long-lived realtime streams).', inFlight);
    return this;
  }
}
