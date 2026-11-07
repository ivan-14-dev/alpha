CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '[]',
  avatar_color TEXT NOT NULL DEFAULT '#6658e8',
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (organization_id, user_id)
);
