-- V4 realtime & notifications (owned by the realtime module; append-only until released).

-- Per user x category channel overrides. Missing rows fall back to code defaults (server/realtime/categories.ts).
-- In-app notifications are always on; categories are validated in code so new ones need no table rebuild.
CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(length(category) BETWEEN 2 AND 40),
  email INTEGER NOT NULL CHECK(email IN (0,1)),
  push INTEGER NOT NULL CHECK(push IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id, category)
);

CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_frequency TEXT NOT NULL DEFAULT 'immediate' CHECK(email_frequency IN ('immediate','daily')),
  last_digest_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX notification_settings_digest ON notification_settings(email_frequency, last_digest_at);

-- Web Push subscriptions. Endpoint + keys are sealed (AES-256-GCM); only a hash (uniqueness) and the
-- push-service host (admin diagnostics) are stored in clear.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL UNIQUE CHECK(length(endpoint_hash) = 64),
  endpoint_host TEXT NOT NULL CHECK(length(endpoint_host) BETWEEN 3 AND 253),
  sealed TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '' CHECK(length(user_agent) <= 200),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  last_success_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id, created_at);

CREATE TABLE push_outbox (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  send_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX push_outbox_pending ON push_outbox(status, send_after);
CREATE INDEX push_outbox_subscription ON push_outbox(subscription_id);
CREATE INDEX push_outbox_user ON push_outbox(user_id, created_at);

-- Read receipts for private conversations (drives conversation.read events and unread counters).
CREATE TABLE conversation_reads (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, user_id)
);
CREATE INDEX conversation_reads_user ON conversation_reads(user_id);
CREATE INDEX notifications_user_kind_link ON notifications(user_id, kind, link);
