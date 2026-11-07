CREATE TABLE bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('project','campaign','listing')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,target_type,target_id)
);
CREATE INDEX bookmarks_recent ON bookmarks(user_id,created_at DESC);

ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);
ALTER TABLE orders ADD COLUMN revision_requested INTEGER NOT NULL DEFAULT 0 CHECK(revision_requested IN (0,1));

CREATE TABLE order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('purchased','delivered','revision_requested','completed','disputed','resumed','legacy_delivery')),
  body TEXT NOT NULL DEFAULT '',
  order_version INTEGER NOT NULL CHECK(order_version >= 1),
  created_at TEXT,
  UNIQUE(order_id,order_version)
);
CREATE INDEX order_events_history ON order_events(order_id,order_version DESC);
INSERT INTO order_events(id,order_id,actor_id,kind,body,order_version,created_at)
  SELECT lower(hex(randomblob(16))),id,seller_id,'legacy_delivery',delivery_text,1,NULL
  FROM orders WHERE delivery_text != '';

ALTER TABLE sessions ADD COLUMN public_id TEXT;
ALTER TABLE sessions ADD COLUMN created_at TEXT;
UPDATE sessions SET public_id=lower(hex(randomblob(16)));
CREATE UNIQUE INDEX session_public_id ON sessions(public_id);
CREATE INDEX session_owner_expiry ON sessions(user_id,expires_at);
