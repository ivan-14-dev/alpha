import { one } from '../db.js';
import { latestSchemaVersion } from '../migrations.js';
import { log } from '../platform/log.js';
import { assertSecretsReady } from '../platform/secrets.js';

export type ReadinessCheck = 'database' | 'migrations' | 'secrets';

export interface Readiness {
  ready: boolean;
  checks: Record<ReadinessCheck, 'ok' | 'failed'>;
  schema_version: number | null;
  latest_schema_version: number;
}

/**
 * Readiness = the instance can serve traffic: the database answers, every known migration is applied
 * and the secrets keyring is usable. Failure details are logged, never returned (endpoint is public).
 */
export function readiness(): Readiness {
  const checks: Readiness['checks'] = { database: 'failed', migrations: 'failed', secrets: 'failed' };
  let schemaVersion: number | null = null;
  try {
    one('SELECT 1 AS ok');
    checks.database = 'ok';
    schemaVersion = one<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations')?.version ?? null;
    if (schemaVersion === latestSchemaVersion) checks.migrations = 'ok';
    else log.warn('ops.readiness.migrations', { current: schemaVersion, latest: latestSchemaVersion });
  } catch (error) {
    log.error('ops.readiness.database', { error });
  }
  try {
    assertSecretsReady();
    checks.secrets = 'ok';
  } catch (error) {
    log.error('ops.readiness.secrets', { error });
  }
  return {
    ready: Object.values(checks).every((status) => status === 'ok'),
    checks,
    schema_version: schemaVersion,
    latest_schema_version: latestSchemaVersion,
  };
}
