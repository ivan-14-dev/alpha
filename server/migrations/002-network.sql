ALTER TABLE posts ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE reviews ADD COLUMN communication_rating INTEGER CHECK(communication_rating BETWEEN 1 AND 5);
ALTER TABLE reviews ADD COLUMN quality_rating INTEGER CHECK(quality_rating BETWEEN 1 AND 5);

CREATE TABLE user_follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id != following_id)
);
CREATE INDEX user_followers ON user_follows(following_id,created_at);
CREATE TABLE project_follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id,project_id)
);
CREATE INDEX project_followers ON project_follows(project_id,created_at);
CREATE INDEX project_posts ON posts(project_id,created_at);
CREATE INDEX author_posts ON posts(author_id,created_at);
CREATE INDEX group_posts ON posts(group_id,created_at);

CREATE TABLE organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES users(id),
  invitee_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('member','admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  responded_at TEXT,
  CHECK(inviter_id != invitee_id)
);
CREATE UNIQUE INDEX pending_organization_invitation ON organization_invitations(organization_id,invitee_id) WHERE status='pending';
CREATE INDEX recipient_invitations ON organization_invitations(invitee_id,status,created_at);

CREATE TABLE project_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  assignee_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
  due_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX project_task_board ON project_tasks(project_id,status,updated_at);
CREATE INDEX assigned_tasks ON project_tasks(assignee_id,status);
