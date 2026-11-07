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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT REFERENCES organizations(id), title TEXT NOT NULL,
  summary TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'prototype', visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private')),
  repo_url TEXT NOT NULL DEFAULT '', demo_url TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', color TEXT NOT NULL DEFAULT '#6658e8',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'usability', reward_cents INTEGER NOT NULL CHECK(reward_cents > 0),
  slots INTEGER NOT NULL CHECK(slots BETWEEN 1 AND 100),
  requirements TEXT NOT NULL DEFAULT '', target_devices TEXT NOT NULL DEFAULT 'Web',
  deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  tester_id TEXT NOT NULL REFERENCES users(id), motivation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(campaign_id,tester_id)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  tester_id TEXT NOT NULL REFERENCES users(id), application_id TEXT NOT NULL UNIQUE REFERENCES applications(id),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','in_progress','submitted','changes_requested','accepted','disputed','paid','cancelled')),
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS test_reports (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL UNIQUE REFERENCES missions(id),
  summary TEXT NOT NULL, steps TEXT NOT NULL, expected TEXT NOT NULL,
  observed TEXT NOT NULL, evidence_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6658e8',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(group_id,user_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT REFERENCES groups(id), body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(post_id,user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
