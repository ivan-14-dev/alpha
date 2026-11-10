-- V4 privacy module schema (owned by the privacy module; append-only until released).
-- GDPR requests (Art. 15/17/20). Rows are kept after completion as accountability evidence (Art. 5.2).
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('export','erasure')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','scheduled','completed','cancelled','rejected')),
  reason TEXT NOT NULL DEFAULT '' CHECK(length(reason) <= 1000),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scheduled_for TEXT,
  processed_at TEXT,
  expires_at TEXT,
  downloaded_at TEXT,
  download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count >= 0),
  rejection_reason TEXT NOT NULL DEFAULT '' CHECK(length(rejection_reason) <= 2000),
  handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(kind = 'erasure' OR scheduled_for IS NULL),
  CHECK(kind = 'export' OR expires_at IS NULL),
  CHECK(status != 'scheduled' OR (kind = 'erasure' AND scheduled_for IS NOT NULL)),
  CHECK(status != 'ready' OR (kind = 'export' AND expires_at IS NOT NULL)),
  CHECK(status != 'rejected' OR length(rejection_reason) > 0)
);
CREATE UNIQUE INDEX privacy_active_erasure ON privacy_requests(user_id) WHERE kind = 'erasure' AND status IN ('pending','processing','scheduled');
CREATE INDEX privacy_requests_user ON privacy_requests(user_id, kind, requested_at DESC);
CREATE INDEX privacy_requests_queue ON privacy_requests(kind, status, scheduled_for);

-- Current consent state per purpose (opt-in: absence = refused) and immutable history (proof of consent, Art. 7.1).
CREATE TABLE consents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('marketing_email','product_updates','analytics')),
  granted INTEGER NOT NULL CHECK(granted IN (0,1)),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 40),
  source TEXT NOT NULL DEFAULT 'settings' CHECK(source IN ('settings','registration','admin','erasure','api')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, purpose)
);
CREATE TABLE consent_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('marketing_email','product_updates','analytics')),
  granted INTEGER NOT NULL CHECK(granted IN (0,1)),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 40),
  source TEXT NOT NULL DEFAULT 'settings' CHECK(source IN ('settings','registration','admin','erasure','api')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX consent_events_user ON consent_events(user_id, created_at DESC);
CREATE TRIGGER consent_events_immutable_update BEFORE UPDATE ON consent_events
BEGIN SELECT RAISE(ABORT, 'consent history is immutable'); END;

-- Personal data breach register (Art. 33.5): every incident is documented, notified or not.
CREATE TABLE breach_register (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 200),
  detected_at TEXT NOT NULL,
  occurred_at TEXT,
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 10000),
  nature TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(nature)),
  data_categories TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(data_categories)),
  affected_count INTEGER NOT NULL DEFAULT 0 CHECK(affected_count >= 0),
  risk_level TEXT NOT NULL DEFAULT 'risk' CHECK(risk_level IN ('none','risk','high')),
  consequences TEXT NOT NULL DEFAULT '' CHECK(length(consequences) <= 10000),
  measures TEXT NOT NULL DEFAULT '' CHECK(length(measures) <= 10000),
  notified_cnil_at TEXT,
  cnil_reference TEXT NOT NULL DEFAULT '' CHECK(length(cnil_reference) <= 200),
  notified_users_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX breach_register_detected ON breach_register(status, detected_at DESC);
