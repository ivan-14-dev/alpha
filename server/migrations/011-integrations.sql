-- V4 integrations module schema (owned by the integrations module; append-only until released).
-- OAuth connections (GitHub, GitLab, Figma), project sources with inbound webhooks, outgoing webhooks.
-- Every token/secret column stores an AES-256-GCM sealed value (server/platform/secrets.ts), never plaintext.

CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('github','gitlab','figma')),
  base_url TEXT NOT NULL CHECK(base_url LIKE 'http%'),
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 200),
  external_login TEXT NOT NULL DEFAULT '',
  access_token_sealed TEXT NOT NULL DEFAULT '',
  refresh_token_sealed TEXT,
  scopes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scopes)),
  expires_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  CHECK(revoked_at IS NOT NULL OR access_token_sealed != '')
);
CREATE UNIQUE INDEX integration_connection_active ON integration_connections(user_id, provider, base_url) WHERE revoked_at IS NULL;
CREATE INDEX integration_connection_user ON integration_connections(user_id, created_at);

-- One-time OAuth `state` values: only the SHA-256 hash is stored, bound to the session user, 10 minutes.
CREATE TABLE integration_oauth_states (
  state_hash TEXT PRIMARY KEY CHECK(length(state_hash) = 64),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('github','gitlab','figma')),
  base_url TEXT NOT NULL,
  code_verifier_sealed TEXT,
  scopes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scopes)),
  return_to TEXT NOT NULL DEFAULT '/integrations' CHECK(substr(return_to, 1, 1) = '/' AND substr(return_to, 2, 1) NOT IN ('/', '\')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX integration_oauth_state_expiry ON integration_oauth_states(expires_at);

CREATE TABLE integration_project_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('github','gitlab','figma')),
  base_url TEXT NOT NULL DEFAULT '',
  connection_id TEXT REFERENCES integration_connections(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 300),
  full_name TEXT NOT NULL CHECK(length(full_name) BETWEEN 1 AND 300),
  url TEXT NOT NULL DEFAULT '',
  default_branch TEXT NOT NULL DEFAULT '',
  webhook_secret_sealed TEXT NOT NULL,
  -- Provider-side webhook ids (comma-separated: Figma needs one webhook per event type). NULL = manual setup.
  provider_webhook_id TEXT,
  setup TEXT NOT NULL DEFAULT 'manual' CHECK(setup IN ('automatic','manual')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_event_at TEXT,
  UNIQUE(project_id, provider, external_id)
);
CREATE INDEX integration_source_project ON integration_project_sources(project_id, created_at);
CREATE INDEX integration_source_creator ON integration_project_sources(created_by);

CREATE TABLE integration_inbound_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('github','gitlab','figma')),
  delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100),
  project_source_id TEXT REFERENCES integration_project_sources(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','ignored','failed')),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 500),
  UNIQUE(provider, delivery_id)
);
CREATE INDEX integration_inbound_project ON integration_inbound_events(project_id, received_at DESC);
CREATE INDEX integration_inbound_received ON integration_inbound_events(received_at DESC);

CREATE TABLE integration_webhook_endpoints (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK(length(url) BETWEEN 8 AND 2000),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 200),
  secret_sealed TEXT NOT NULL,
  -- Previous secret stays valid (second v1 signature) for 24 h after a rotation.
  previous_secret_sealed TEXT,
  previous_secret_expires_at TEXT,
  events TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(events) AND json_type(events) = 'array'),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  disabled_reason TEXT NOT NULL DEFAULT '',
  last_success_at TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX integration_endpoint_project ON integration_webhook_endpoints(project_id, active);
CREATE INDEX integration_endpoint_owner ON integration_webhook_endpoints(owner_id);

CREATE TABLE integration_webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES integration_webhook_endpoints(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivering','succeeded','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT,
  response_status INTEGER,
  last_error TEXT NOT NULL DEFAULT '' CHECK(length(last_error) <= 500),
  duration_ms INTEGER,
  -- Id of the delivery this row re-sends (informational, no FK: purging the original must not touch redeliveries).
  redelivery_of TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX integration_delivery_once ON integration_webhook_deliveries(endpoint_id, event_id) WHERE redelivery_of IS NULL;
CREATE INDEX integration_delivery_due ON integration_webhook_deliveries(status, next_attempt_at);
CREATE INDEX integration_delivery_endpoint ON integration_webhook_deliveries(endpoint_id, created_at DESC);
