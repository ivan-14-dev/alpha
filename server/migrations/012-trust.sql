-- V4 trust & anti-abuse module schema (owned by the trust module; append-only once released).
-- Privacy: risk signals only store keyed HMAC hashes of IP / device / user agent, never raw values.

CREATE TABLE risk_signals (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 2 AND 40),
  ip_hash TEXT CHECK(ip_hash IS NULL OR length(ip_hash) = 64),
  -- 'private' covers loopback, RFC 1918, CGNAT and link-local ranges: never used alone for detection.
  ip_scope TEXT NOT NULL DEFAULT 'none' CHECK(ip_scope IN ('public','private','none')),
  device_hash TEXT CHECK(device_hash IS NULL OR length(device_hash) = 64),
  ua_hash TEXT CHECK(ua_hash IS NULL OR length(ua_hash) = 64),
  meta TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(meta) AND json_type(meta) = 'object'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX risk_signals_device ON risk_signals(device_hash, created_at);
CREATE INDEX risk_signals_ip ON risk_signals(ip_hash, created_at);
CREATE INDEX risk_signals_user ON risk_signals(user_id, kind, created_at);
CREATE INDEX risk_signals_kind ON risk_signals(kind, created_at);
CREATE INDEX risk_signals_created ON risk_signals(created_at);

CREATE TABLE risk_cases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('multi_account','collusion','review_ring','velocity','payment_fraud','self_dealing','manual')),
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','actioned','dismissed')),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 500),
  -- Hashes (truncated), resource ids and counts only: never raw IP, e-mail or free text from members.
  evidence TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence) AND json_type(evidence) = 'object'),
  related_user_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(related_user_ids) AND json_type(related_user_ids) = 'array'),
  dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) BETWEEN 3 AND 200),
  detections INTEGER NOT NULL DEFAULT 1 CHECK(detections >= 1),
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT NOT NULL DEFAULT '' CHECK(length(resolution_note) <= 4000),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  notified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  CHECK((status IN ('open','reviewing')) = (resolved_at IS NULL))
);
-- Detectors are idempotent: at most one active case per pattern.
CREATE UNIQUE INDEX risk_cases_open_dedupe ON risk_cases(dedupe_key) WHERE status IN ('open','reviewing');
CREATE INDEX risk_cases_dedupe_history ON risk_cases(dedupe_key, resolved_at);
CREATE INDEX risk_cases_queue ON risk_cases(status, score DESC, created_at);
CREATE INDEX risk_cases_user ON risk_cases(user_id, status);

-- Every user involved in a case (primary + related) for indexed risk lookups.
CREATE TABLE risk_case_subjects (
  case_id TEXT NOT NULL REFERENCES risk_cases(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'related' CHECK(role IN ('primary','related')),
  PRIMARY KEY (case_id, user_id)
);
CREATE INDEX risk_case_subjects_user ON risk_case_subjects(user_id, case_id);

CREATE TABLE sanctions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('warning','restriction','suspension','ban')),
  capabilities TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities) AND json_type(capabilities) = 'array'),
  -- DSA art. 17 statement of reasons: facts (public_reason) + contractual/legal ground.
  ground TEXT NOT NULL DEFAULT 'terms.other' CHECK(length(ground) BETWEEN 3 AND 60),
  public_reason TEXT NOT NULL CHECK(length(public_reason) BETWEEN 10 AND 2000),
  internal_note TEXT NOT NULL DEFAULT '' CHECK(length(internal_note) <= 4000),
  starts_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ends_at TEXT,
  appealable INTEGER NOT NULL DEFAULT 1 CHECK(appealable IN (0,1)),
  automated INTEGER NOT NULL DEFAULT 0 CHECK(automated IN (0,1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  case_id TEXT REFERENCES risk_cases(id) ON DELETE SET NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason TEXT NOT NULL DEFAULT '' CHECK(length(revoked_reason) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(ends_at IS NULL OR ends_at > starts_at),
  CHECK(kind != 'warning' OR json_array_length(capabilities) = 0),
  CHECK(kind = 'warning' OR json_array_length(capabilities) > 0),
  CHECK(appealable = 1 OR kind = 'ban'),
  CHECK(revoked_at IS NOT NULL OR revoked_by IS NULL)
);
CREATE INDEX sanctions_user_active ON sanctions(user_id, revoked_at, ends_at);
CREATE INDEX sanctions_case ON sanctions(case_id);
CREATE INDEX sanctions_recent ON sanctions(created_at);

CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  sanction_id TEXT NOT NULL REFERENCES sanctions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 30 AND 3000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT NOT NULL DEFAULT '' CHECK(length(decision_note) <= 4000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  CHECK((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX appeals_one_pending ON appeals(sanction_id) WHERE status = 'pending';
CREATE INDEX appeals_queue ON appeals(status, created_at);
CREATE INDEX appeals_user ON appeals(user_id, created_at);
CREATE INDEX appeals_sanction ON appeals(sanction_id, created_at);
CREATE TRIGGER appeals_per_sanction_limit BEFORE INSERT ON appeals
WHEN (SELECT COUNT(*) FROM appeals WHERE sanction_id = NEW.sanction_id) >= 2
BEGIN SELECT RAISE(ABORT, 'appeal limit reached for this sanction'); END;
