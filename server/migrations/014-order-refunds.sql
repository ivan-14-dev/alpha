-- V4: marketplace order history records escrow refunds decided by moderation (kind 'refunded').
-- SQLite cannot ALTER a CHECK constraint, so order_events is rebuilt with identical columns, keys and index.
-- No table references order_events and it has no triggers.
CREATE TABLE order_events_v4 (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('purchased','delivered','revision_requested','completed','disputed','resumed','legacy_delivery','refunded')),
  body TEXT NOT NULL DEFAULT '',
  order_version INTEGER NOT NULL CHECK(order_version >= 1),
  created_at TEXT,
  UNIQUE(order_id,order_version)
);
INSERT INTO order_events_v4(id,order_id,actor_id,kind,body,order_version,created_at)
  SELECT id,order_id,actor_id,kind,body,order_version,created_at FROM order_events;
DROP TABLE order_events;
ALTER TABLE order_events_v4 RENAME TO order_events;
CREATE INDEX order_events_history ON order_events(order_id,order_version DESC);
