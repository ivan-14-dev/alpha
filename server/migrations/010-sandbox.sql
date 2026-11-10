-- V4 sandbox module: isolated executions of campaign builds (owned by the sandbox module).
CREATE TABLE sandbox_runs (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL DEFAULT '' CHECK(length(file_name) <= 255),
  file_sha256 TEXT NOT NULL DEFAULT '',
  profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 60),
  profile_label TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL CHECK(length(image) BETWEEN 1 AND 300),
  -- Snapshots taken at request time: later admin edits never change what a queued run executes.
  command TEXT NOT NULL CHECK(json_valid(command) AND json_type(command) = 'array'),
  limits TEXT NOT NULL CHECK(json_valid(limits) AND json_type(limits) = 'object'),
  runtime TEXT NOT NULL DEFAULT 'docker',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','succeeded','failed','timeout','cancelled','error')),
  exit_code INTEGER,
  queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  logs TEXT NOT NULL DEFAULT '' CHECK(length(logs) <= 262144),
  logs_truncated INTEGER NOT NULL DEFAULT 0 CHECK(logs_truncated IN (0,1)),
  logs_pruned_at TEXT,
  container_name TEXT NOT NULL UNIQUE CHECK(container_name GLOB 'alpha-sbx-*'),
  cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  error TEXT NOT NULL DEFAULT '' CHECK(length(error) <= 2000),
  artifact_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  CHECK(status != 'queued' OR started_at IS NULL),
  CHECK(finished_at IS NULL OR status IN ('succeeded','failed','timeout','cancelled','error'))
);
CREATE INDEX sandbox_runs_requester ON sandbox_runs(requester_id, queued_at);
CREATE INDEX sandbox_runs_campaign ON sandbox_runs(campaign_id, queued_at);
CREATE INDEX sandbox_runs_queue ON sandbox_runs(status, queued_at) WHERE status IN ('queued','running');
CREATE INDEX sandbox_runs_finished ON sandbox_runs(finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX sandbox_runs_file ON sandbox_runs(file_id);

-- A finished run is immutable except for retention (log pruning) and artifact linking.
CREATE TRIGGER sandbox_runs_terminal_status BEFORE UPDATE OF status ON sandbox_runs
WHEN OLD.status IN ('succeeded','failed','timeout','cancelled','error') AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT, 'sandbox run already finished'); END;

-- Per-user daily usage (UTC day). Kept separately so quotas survive run deletion and retention.
CREATE TABLE sandbox_daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  runs INTEGER NOT NULL DEFAULT 0 CHECK(runs >= 0),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0),
  PRIMARY KEY(user_id, day)
);
CREATE INDEX sandbox_daily_usage_day ON sandbox_daily_usage(day);
