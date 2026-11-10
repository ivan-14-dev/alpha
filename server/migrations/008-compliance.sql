-- V4 compliance module: identity verification (KYC), payout methods, withdrawals and invoices.
-- Personal fields are erasable (privacy module) but withdrawals and invoices are kept 10 years (accounting law).

CREATE TABLE kyc_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),
  level TEXT NOT NULL DEFAULT 'none' CHECK(level IN ('none','basic','enhanced')),
  legal_name TEXT NOT NULL DEFAULT '' CHECK(length(legal_name) <= 160),
  country TEXT CHECK(country IS NULL OR (length(country) = 2 AND country = upper(country))),
  date_of_birth TEXT CHECK(date_of_birth IS NULL OR date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- AES-256-GCM sealed JSON {line1,line2,postal_code,city,region}, context `kyc:<userId>`.
  address_sealed TEXT,
  -- JSON array of files.id (purpose kyc_document, resource kyc/<userId>).
  document_file_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(document_file_ids) AND json_type(document_file_ids) = 'array'),
  submitted_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  rejection_reason TEXT NOT NULL DEFAULT '' CHECK(length(rejection_reason) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX kyc_profiles_status ON kyc_profiles(status, submitted_at);

CREATE TABLE payout_methods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('mobile_money','bank_account','stripe_connect')),
  -- Preferred payment provider id (NULL = any enabled provider supporting the method/currency).
  provider TEXT CHECK(provider IS NULL OR length(provider) BETWEEN 2 AND 40),
  label TEXT NOT NULL DEFAULT '' CHECK(length(label) <= 80),
  -- AES-256-GCM sealed JSON details, context `payout:<id>`. Emptied when the method is deleted or erased.
  details_sealed TEXT NOT NULL,
  display_mask TEXT NOT NULL CHECK(length(display_mask) <= 80),
  -- Keyed hash of the normalized account identifier: duplicate detection and shared-account risk signals.
  fingerprint TEXT NOT NULL,
  country TEXT NOT NULL CHECK(length(country) = 2 AND country = upper(country)),
  currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  verified_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(deleted_at IS NULL OR is_default = 0)
);
CREATE INDEX payout_methods_user ON payout_methods(user_id, deleted_at, created_at);
CREATE INDEX payout_methods_fingerprint ON payout_methods(fingerprint);
CREATE UNIQUE INDEX payout_methods_one_default ON payout_methods(user_id) WHERE is_default = 1 AND deleted_at IS NULL;
CREATE UNIQUE INDEX payout_methods_unique_account ON payout_methods(user_id, fingerprint) WHERE deleted_at IS NULL;

CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payout_method_id TEXT NOT NULL REFERENCES payout_methods(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 2 AND 40),
  -- Ledger amount (base currency minor units) and the converted payout amount (rounded down).
  amount_base_minor INTEGER NOT NULL CHECK(amount_base_minor > 0),
  base_currency TEXT NOT NULL CHECK(length(base_currency) = 3),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  status TEXT NOT NULL CHECK(status IN ('requested','on_hold','approved','processing','paid','failed','rejected','cancelled')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low','medium','high')),
  hold_reason TEXT NOT NULL DEFAULT '' CHECK(length(hold_reason) <= 200),
  review_note TEXT NOT NULL DEFAULT '' CHECK(length(review_note) <= 1000),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  -- Reference sent to the provider (idempotency key): the withdrawal id, suffixed after a confirmed failure.
  payout_reference TEXT,
  provider_reference TEXT,
  failure_reason TEXT NOT NULL DEFAULT '' CHECK(length(failure_reason) <= 500),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 100),
  processing_started_at TEXT,
  paid_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX withdrawals_user ON withdrawals(user_id, created_at);
CREATE INDEX withdrawals_queue ON withdrawals(status, next_attempt_at);
CREATE INDEX withdrawals_method ON withdrawals(payout_method_id, status);

-- Continuous numbering per series (live / sandbox) and calendar year: ALPHA-2026-000001, ALPHA-SBX-2026-000001.
CREATE TABLE invoice_counters (
  series TEXT NOT NULL CHECK(series IN ('live','sandbox')),
  year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 9999),
  last_number INTEGER NOT NULL DEFAULT 0 CHECK(last_number >= 0),
  PRIMARY KEY(series, year)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  series TEXT NOT NULL CHECK(series IN ('live','sandbox')),
  year INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('receipt','commission','payout_statement')),
  journal_id TEXT NOT NULL REFERENCES ledger_journals(id) ON DELETE RESTRICT,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  amount_net_minor INTEGER NOT NULL CHECK(amount_net_minor >= 0),
  amount_tax_minor INTEGER NOT NULL CHECK(amount_tax_minor >= 0),
  amount_gross_minor INTEGER NOT NULL CHECK(amount_gross_minor = amount_net_minor + amount_tax_minor),
  tax_rate_bps INTEGER NOT NULL CHECK(tax_rate_bps BETWEEN 0 AND 10000),
  description TEXT NOT NULL CHECK(length(description) <= 500),
  lines TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(lines)),
  issuer_snapshot TEXT NOT NULL CHECK(json_valid(issuer_snapshot)),
  customer_snapshot TEXT NOT NULL CHECK(json_valid(customer_snapshot)),
  issued_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(kind, journal_id),
  UNIQUE(series, year, sequence)
);
CREATE INDEX invoices_user ON invoices(user_id, issued_at);
CREATE INDEX invoices_issued ON invoices(issued_at);
-- An issued invoice is never modified or deleted (corrections are new documents).
CREATE TRIGGER invoices_immutable_update BEFORE UPDATE ON invoices
BEGIN SELECT RAISE(ABORT, 'invoices are immutable'); END;
CREATE TRIGGER invoices_immutable_delete BEFORE DELETE ON invoices
BEGIN SELECT RAISE(ABORT, 'invoices are immutable'); END;

-- Background job cursors (e.g. `invoices` = last ledger_journals rowid scanned).
CREATE TABLE compliance_cursors (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
