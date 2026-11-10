-- V4 payments module schema (owned by the payments module; append-only until released).
-- Real money flows (sandbox/live): payment intents, webhook inbox, refunds. Demo money stays in `transactions`.

-- A campaign/order is bound to the payment mode of its first real funding/purchase and never mixes demo and real funds.
ALTER TABLE campaigns ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'demo' CHECK(payment_mode IN ('demo','sandbox','live'));
ALTER TABLE orders ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'demo' CHECK(payment_mode IN ('demo','sandbox','live'));

-- One collection attempt with a provider. Amounts: `amount_base_minor` is credited to the ledger (base currency),
-- `amount_minor`/`currency` is what the provider collects. The order of an `order_purchase` intent only exists once paid.
CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK(purpose IN ('campaign_funding','order_purchase')),
  ref_type TEXT NOT NULL CHECK(ref_type IN ('campaign','listing')),
  ref_id TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 2 AND 40),
  method TEXT CHECK(method IS NULL OR method IN ('card','mobile_money','bank_transfer')),
  operator TEXT CHECK(operator IS NULL OR length(operator) <= 20),
  provider_reference TEXT CHECK(provider_reference IS NULL OR length(provider_reference) <= 200),
  amount_base_minor INTEGER NOT NULL CHECK(amount_base_minor > 0),
  base_currency TEXT NOT NULL CHECK(length(base_currency) = 3),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  fx_rate REAL NOT NULL DEFAULT 1 CHECK(fx_rate > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','pending','succeeded','failed','cancelled','expired')),
  failure_reason TEXT NOT NULL DEFAULT '',
  -- none: not settled yet; settled: ledger journal posted; unapplied: paid but no longer applicable (auto refund).
  settlement TEXT NOT NULL DEFAULT 'none' CHECK(settlement IN ('none','settled','unapplied')),
  -- Set when the provider reported an amount/currency different from the intent: never credited, admin review.
  review_required INTEGER NOT NULL DEFAULT 0 CHECK(review_required IN (0,1)),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  redirect_url TEXT CHECK(redirect_url IS NULL OR length(redirect_url) <= 2000),
  instructions TEXT NOT NULL DEFAULT '',
  -- Only a masked phone (e.g. +2376•••••89) is ever stored.
  customer_phone_masked TEXT NOT NULL DEFAULT '',
  settled_journal_id TEXT REFERENCES ledger_journals(id) ON DELETE RESTRICT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_check_at TEXT,
  last_checked_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX payment_intents_provider_reference ON payment_intents(provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payment_intents_user ON payment_intents(user_id, created_at);
CREATE INDEX payment_intents_ref ON payment_intents(ref_type, ref_id, status);
CREATE INDEX payment_intents_open ON payment_intents(status, next_check_at) WHERE status IN ('created','pending');
CREATE INDEX payment_intents_order ON payment_intents(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX payment_intents_mode_status ON payment_intents(mode, status, created_at);

-- Webhook inbox: one row per provider event (provider event id, or sha256 of the raw body when the provider has none).
CREATE TABLE payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 2 AND 40),
  event_key TEXT NOT NULL CHECK(length(event_key) BETWEEN 1 AND 300),
  mode TEXT CHECK(mode IS NULL OR mode IN ('sandbox','live')),
  event_type TEXT NOT NULL DEFAULT '' CHECK(length(event_type) <= 40),
  event_status TEXT NOT NULL DEFAULT '' CHECK(length(event_status) <= 40),
  reference TEXT CHECK(reference IS NULL OR length(reference) <= 200),
  provider_reference TEXT CHECK(provider_reference IS NULL OR length(provider_reference) <= 200),
  intent_id TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','ignored','failed')),
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  UNIQUE(provider, event_key)
);
CREATE INDEX payment_webhook_events_status ON payment_webhook_events(status, received_at);
CREATE INDEX payment_webhook_events_intent ON payment_webhook_events(intent_id) WHERE intent_id IS NOT NULL;

-- Provider refunds. The ledger journal (order.refunded / campaign.refunded) is posted when the refund is requested;
-- the provider call happens after commit and is retried by the `payments.reconcile` job.
CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  journal_id TEXT REFERENCES ledger_journals(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 2 AND 40),
  amount_base_minor INTEGER NOT NULL CHECK(amount_base_minor > 0),
  base_currency TEXT NOT NULL CHECK(length(base_currency) = 3),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  reason TEXT NOT NULL DEFAULT '' CHECK(length(reason) <= 1000),
  provider_reference TEXT CHECK(provider_reference IS NULL OR length(provider_reference) <= 200),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX refunds_status ON refunds(status, next_attempt_at);
CREATE INDEX refunds_intent ON refunds(intent_id);
CREATE INDEX refunds_order ON refunds(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX refunds_campaign ON refunds(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE UNIQUE INDEX refunds_provider_reference ON refunds(provider, provider_reference) WHERE provider_reference IS NOT NULL;

-- Platform fees live in platform_settings `payments.fees` = {testing_fee_bps, marketplace_fee_bps} (defaults in code).
