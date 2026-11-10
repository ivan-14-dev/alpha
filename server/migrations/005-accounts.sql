-- V4 accounts module schema (owned by the accounts module; append-only until released).
-- Email verification, password recovery, TOTP MFA and OAuth (GitHub/Google) sign-in.

-- Existing accounts predate verification: they are treated as verified at their creation date.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- Single-use links. Only the SHA-256 of the random token is stored.
CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX email_verification_user ON email_verification_tokens(user_id, created_at);
CREATE INDEX email_verification_expiry ON email_verification_tokens(expires_at);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX password_reset_user ON password_reset_tokens(user_id, created_at);
CREATE INDEX password_reset_expiry ON password_reset_tokens(expires_at);

-- TOTP (RFC 6238). The secret is sealed with AES-256-GCM (context `mfa:<userId>`).
-- enabled_at IS NULL means a pending setup that has not been confirmed with a code yet.
CREATE TABLE mfa_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_sealed TEXT NOT NULL,
  enabled_at TEXT,
  last_used_step INTEGER CHECK(last_used_step IS NULL OR last_used_step >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX mfa_totp_enabled ON mfa_totp(enabled_at);

CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK(length(code_hash) = 64),
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, code_hash)
);

-- Second step of a sign-in (password or OAuth succeeded, TOTP/recovery code pending). No session exists yet.
CREATE TABLE mfa_challenges (
  id_hash TEXT PRIMARY KEY CHECK(length(id_hash) = 64),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('password','oauth')),
  provider TEXT CHECK(provider IS NULL OR provider IN ('github','google')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX mfa_challenges_user ON mfa_challenges(user_id);
CREATE INDEX mfa_challenges_expiry ON mfa_challenges(expires_at);

CREATE TABLE oauth_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('github','google')),
  provider_user_id TEXT NOT NULL CHECK(length(provider_user_id) BETWEEN 1 AND 255),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  UNIQUE(provider, provider_user_id),
  UNIQUE(user_id, provider)
);

-- Pending authorization requests (authorization code + PKCE). The verifier is sealed (context `oauth-state:<state_hash>`).
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY CHECK(length(state_hash) = 64),
  provider TEXT NOT NULL CHECK(provider IN ('github','google')),
  mode TEXT NOT NULL CHECK(mode IN ('login','link')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  verifier_sealed TEXT NOT NULL,
  redirect_path TEXT NOT NULL DEFAULT '/' CHECK(substr(redirect_path, 1, 1) = '/' AND substr(redirect_path, 2, 1) NOT IN ('/', '\')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(mode = 'login' OR user_id IS NOT NULL)
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
