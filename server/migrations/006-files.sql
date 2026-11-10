-- V4 files module: encrypted storage metadata, antivirus retries, retention and KYC access log.
-- The `files` table itself comes from 004-platform.sql; this migration only extends it.
ALTER TABLE files ADD COLUMN detected_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN key_fingerprint TEXT;
ALTER TABLE files ADD COLUMN scan_attempts INTEGER NOT NULL DEFAULT 0 CHECK(scan_attempts >= 0);
ALTER TABLE files ADD COLUMN next_scan_at TEXT;
ALTER TABLE files ADD COLUMN quarantined_at TEXT;
ALTER TABLE files ADD COLUMN purged_at TEXT;
ALTER TABLE files ADD COLUMN attached_at TEXT;
ALTER TABLE files ADD COLUMN retain_until TEXT;
ALTER TABLE files ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX files_pending_scan ON files(scan_status, next_scan_at) WHERE deleted_at IS NULL;
CREATE INDEX files_unattached ON files(purpose, created_at) WHERE resource_type IS NULL AND deleted_at IS NULL;
CREATE INDEX files_purge ON files(deleted_at) WHERE purged_at IS NULL;

-- Every administrator access to a KYC document (metadata, download, server-side read) is recorded here.
CREATE TABLE file_access_log (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK(action IN ('metadata','download','read','list')),
  reason TEXT NOT NULL DEFAULT '' CHECK(length(reason) <= 500),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX file_access_log_file ON file_access_log(file_id, at);
CREATE INDEX file_access_log_actor ON file_access_log(actor_id, at);
CREATE INDEX file_access_log_recent ON file_access_log(at);
