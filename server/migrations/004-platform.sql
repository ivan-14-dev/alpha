-- V4 platform foundation shared by every production module.
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 3 AND 120),
  value TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(value)),
  secret TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK(sensitive IN (0,1)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','logged','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  send_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX email_outbox_pending ON email_outbox(status, send_after);
CREATE INDEX email_outbox_user ON email_outbox(user_id, created_at);

CREATE TABLE rate_limit_buckets (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK(count >= 0),
  reset_at TEXT NOT NULL
);
CREATE INDEX rate_limit_reset ON rate_limit_buckets(reset_at);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK(encrypted IN (0,1)),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','clean','infected','error','skipped')),
  scan_detail TEXT NOT NULL DEFAULT '',
  scanned_at TEXT,
  resource_type TEXT,
  resource_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX files_owner ON files(owner_id, created_at);
CREATE INDEX files_resource ON files(resource_type, resource_id);
CREATE INDEX files_scan ON files(scan_status, created_at);

CREATE TABLE legal_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, document, version)
);

CREATE TABLE job_runs (
  name TEXT PRIMARY KEY,
  runs INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_status TEXT CHECK(last_status IS NULL OR last_status IN ('running','ok','failed')),
  last_error TEXT NOT NULL DEFAULT ''
);

-- Balanced double-entry ledger for sandbox/live money. Demo V1-V3 transactions stay in `transactions`.
CREATE TABLE ledger_journals (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ledger_journal_ref ON ledger_journals(ref_type, ref_id);
CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES ledger_journals(id),
  account TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(journal_id, account)
);
CREATE INDEX ledger_account_balance ON ledger_entries(account, mode, currency);
CREATE TRIGGER ledger_entries_immutable_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_entries_immutable_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_journals_immutable_update BEFORE UPDATE ON ledger_journals
BEGIN SELECT RAISE(ABORT, 'ledger journals are immutable'); END;
CREATE TRIGGER ledger_journals_immutable_delete BEFORE DELETE ON ledger_journals
BEGIN SELECT RAISE(ABORT, 'ledger journals are immutable'); END;
