-- Migration number: 0001 	 2026-10-25T06:08:03.543Z
-- 一本道に要る22表。列と制約は docs/data-model.md の写し。残す18表は使う機能の Issue で足す
-- 主キーに NOT NULL を書くのは、SQLite の通常の表では PRIMARY KEY が NULL を拒まないため

-- 共通の表

CREATE TABLE accounts (
  id TEXT NOT NULL PRIMARY KEY,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE account_logins (
  login_provider TEXT NOT NULL,
  login_subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  login_name TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (login_provider, login_subject)
);

CREATE INDEX account_logins_account_id ON account_logins (account_id);

-- ハッシュの列は SHA-256 の小文字の16進に限る。ハッシュする前のトークンを入れる取り違えを、DB の写しやログから読める形で残さないため
CREATE TABLE sessions (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_account_id ON sessions (account_id);

CREATE TABLE oauth_states (
  state TEXT NOT NULL PRIMARY KEY,
  login_provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce TEXT,
  claim_token_hash TEXT CHECK (length(claim_token_hash) = 64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*'),
  -- 自分のサイトのパスだけ。//evil.example や /\evil.example は別のサイトへの移動になる
  return_to TEXT CHECK (return_to GLOB '/*' AND return_to NOT GLOB '//*' AND return_to NOT GLOB '/\*'),
  expires_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT NOT NULL PRIMARY KEY,
  window_start_at TEXT NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE organizations (
  id TEXT NOT NULL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (
    slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 2 AND 40
  ),
  name TEXT NOT NULL,
  vocabulary TEXT NOT NULL DEFAULT 'game' CHECK (vocabulary IN ('game', 'scrum')),
  theme TEXT NOT NULL DEFAULT 'simple' CHECK (
    theme IN ('simple', 'simple_light', 'simple_dark', 'medieval', 'modern')
  ),
  suspended_at TEXT,
  purge_on TEXT CHECK (purge_on IS date(purge_on)),
  member_limit INTEGER NOT NULL DEFAULT 15 CHECK (member_limit > 0),
  attachment_quota_bytes INTEGER NOT NULL DEFAULT 32212254720,
  attachment_quota_warned_at TEXT,
  stores_source_payload INTEGER NOT NULL DEFAULT 0 CHECK (stores_source_payload IN (0, 1)),
  created_by_operator TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 組織の中の表

CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  account_id TEXT REFERENCES accounts (id),
  login_provider TEXT NOT NULL,
  login_subject TEXT,
  login_email TEXT,
  claim_token_hash TEXT UNIQUE CHECK (length(claim_token_hash) = 64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*'),
  claim_expires_at TEXT,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  work_start_on TEXT CHECK (work_start_on IS date(work_start_on)),
  work_end_on TEXT CHECK (work_end_on IS date(work_end_on)),
  disabled_at TEXT,
  last_seen_at TEXT,
  theme TEXT CHECK (theme IN ('simple', 'simple_light', 'simple_dark', 'medieval', 'modern')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((login_subject IS NULL) = (login_email IS NOT NULL)),
  CHECK (
    (login_email IS NULL) = (claim_token_hash IS NULL)
    AND (login_email IS NULL) = (claim_expires_at IS NULL)
  ),
  CHECK (
    login_email IS NULL OR (login_provider = 'google' AND login_email = lower(trim(login_email)))
  )
);

CREATE UNIQUE INDEX users_organization_login ON users (organization_id, login_provider, login_subject);
CREATE UNIQUE INDEX users_organization_account ON users (organization_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX users_login ON users (login_provider, login_subject);

CREATE TABLE workspaces (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  week_start INTEGER NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  vocabulary TEXT NOT NULL DEFAULT 'game' CHECK (vocabulary IN ('game', 'scrum')),
  definition_of_done_md TEXT CHECK (length(definition_of_done_md) <= 100000),
  closed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX workspaces_organization_id ON workspaces (organization_id);

CREATE TABLE workspace_point_rates (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  effective_month TEXT NOT NULL CHECK (effective_month || '-01' IS date(effective_month || '-01')),
  hours_per_point REAL NOT NULL CHECK (hours_per_point > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, effective_month)
);

CREATE TABLE memberships (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  joined_on TEXT NOT NULL CHECK (joined_on IS date(joined_on)),
  left_on TEXT CHECK (left_on IS date(left_on)),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  CHECK ((left_on IS NULL) = (left_at IS NULL)),
  CHECK (left_on >= joined_on)
);

CREATE UNIQUE INDEX memberships_current ON memberships (workspace_id, user_id) WHERE left_at IS NULL;
CREATE INDEX memberships_user_current ON memberships (user_id) WHERE left_at IS NULL;

CREATE TABLE invitations (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  login_provider TEXT NOT NULL,
  login_subject TEXT,
  login_email TEXT,
  claim_token_hash TEXT UNIQUE CHECK (length(claim_token_hash) = 64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*'),
  claim_expires_at TEXT,
  login_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  invited_by TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  responded_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((login_subject IS NULL) = (login_email IS NOT NULL)),
  CHECK (
    (login_email IS NULL) = (claim_token_hash IS NULL)
    AND (login_email IS NULL) = (claim_expires_at IS NULL)
  ),
  CHECK (
    login_email IS NULL OR (login_provider = 'google' AND login_email = lower(trim(login_email)))
  )
);

CREATE UNIQUE INDEX invitations_pending_subject ON invitations (workspace_id, login_provider, login_subject)
  WHERE status = 'pending';
CREATE UNIQUE INDEX invitations_pending_email ON invitations (workspace_id, login_provider, login_email)
  WHERE status = 'pending' AND login_subject IS NULL;
CREATE INDEX invitations_login_pending ON invitations (login_provider, login_subject) WHERE status = 'pending';

-- ワークスペースの定義

CREATE TABLE board_columns (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT,
  is_done INTEGER NOT NULL DEFAULT 0 CHECK (is_done IN (0, 1)),
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (is_done = 1 OR name IS NOT NULL)
);

CREATE UNIQUE INDEX board_columns_done ON board_columns (workspace_id) WHERE is_done = 1;
CREATE INDEX board_columns_workspace ON board_columns (workspace_id, position) WHERE deleted_at IS NULL;

CREATE TABLE detail_fields (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX detail_fields_workspace ON detail_fields (workspace_id, position) WHERE deleted_at IS NULL;

CREATE TABLE categories (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL,
  is_billed_monthly INTEGER NOT NULL DEFAULT 0 CHECK (is_billed_monthly IN (0, 1)),
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX categories_workspace ON categories (workspace_id, position) WHERE deleted_at IS NULL;

CREATE TABLE repositories (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL,
  provider TEXT,
  source_container_id TEXT,
  source_container_name TEXT,
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (provider IS NULL) = (source_container_id IS NULL)
    AND (provider IS NULL) = (source_container_name IS NULL)
  )
);

CREATE UNIQUE INDEX repositories_source ON repositories (workspace_id, provider, source_container_id)
  WHERE deleted_at IS NULL AND provider IS NOT NULL;
CREATE INDEX repositories_workspace ON repositories (workspace_id, position) WHERE deleted_at IS NULL;

-- 計画と作業

CREATE TABLE epics (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  title TEXT NOT NULL,
  body_md TEXT CHECK (length(body_md) <= 100000),
  category_id TEXT REFERENCES categories (id),
  due_on TEXT CHECK (due_on IS date(due_on)),
  link_url TEXT CHECK (link_url LIKE 'http://%' OR link_url LIKE 'https://%'),
  reward_tier TEXT NOT NULL CHECK (reward_tier IN ('small', 'medium', 'large')),
  requester_user_id TEXT NOT NULL REFERENCES users (id),
  created_by TEXT NOT NULL REFERENCES users (id),
  completed_at TEXT,
  completed_by TEXT REFERENCES users (id),
  canceled_at TEXT,
  canceled_by TEXT REFERENCES users (id),
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (completed_at IS NULL OR canceled_at IS NULL)
);

CREATE INDEX epics_workspace ON epics (workspace_id, position) WHERE deleted_at IS NULL;

CREATE TABLE stories (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  epic_id TEXT REFERENCES epics (id),
  title TEXT NOT NULL,
  acceptance_criteria_md TEXT CHECK (length(acceptance_criteria_md) <= 100000),
  body_md TEXT CHECK (length(body_md) <= 100000),
  category_id TEXT REFERENCES categories (id),
  due_on TEXT CHECK (due_on IS date(due_on)),
  link_url TEXT CHECK (link_url LIKE 'http://%' OR link_url LIKE 'https://%'),
  created_by TEXT NOT NULL REFERENCES users (id),
  completed_at TEXT,
  completed_by TEXT REFERENCES users (id),
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX stories_workspace_epic ON stories (workspace_id, epic_id, position) WHERE deleted_at IS NULL;

CREATE TABLE sprints (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT,
  goal TEXT,
  start_on TEXT NOT NULL CHECK (start_on IS date(start_on)),
  end_on TEXT NOT NULL CHECK (end_on IS date(end_on)),
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
  extended_days INTEGER NOT NULL DEFAULT 0,
  is_goal_achieved INTEGER CHECK (is_goal_achieved IN (0, 1)),
  started_at TEXT,
  started_by TEXT REFERENCES users (id),
  closed_at TEXT,
  closed_by TEXT REFERENCES users (id),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (julianday(end_on) - julianday(start_on) BETWEEN 0 AND 27)
);

CREATE UNIQUE INDEX sprints_active ON sprints (workspace_id) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX sprints_workspace_start ON sprints (workspace_id, start_on) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  is_imported INTEGER NOT NULL CHECK (is_imported IN (0, 1)),
  tray TEXT NOT NULL CHECK (tray IN ('inbox', 'backlog', 'archive')),
  title TEXT NOT NULL,
  body_md TEXT CHECK (length(body_md) <= 100000),
  link_url TEXT CHECK (link_url LIKE 'http://%' OR link_url LIKE 'https://%'),
  story_id TEXT REFERENCES stories (id),
  category_id TEXT REFERENCES categories (id),
  repository_id TEXT REFERENCES repositories (id),
  sprint_id TEXT REFERENCES sprints (id),
  column_id TEXT REFERENCES board_columns (id),
  assignee_user_id TEXT REFERENCES users (id),
  points INTEGER CHECK (points IN (0, 1, 2, 3, 5, 8, 13)),
  due_on TEXT CHECK (due_on IS date(due_on)),
  today_on TEXT CHECK (today_on IS date(today_on)),
  completed_at TEXT,
  completed_by TEXT REFERENCES users (id),
  position TEXT NOT NULL,
  column_position TEXT,
  created_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (is_imported = 1 OR tray = 'backlog'),
  CHECK (is_imported = 0 OR link_url IS NULL),
  CHECK (is_imported = 1 OR created_by IS NOT NULL),
  CHECK (tray = 'backlog' OR (sprint_id IS NULL AND column_id IS NULL AND story_id IS NULL)),
  CHECK ((sprint_id IS NULL) = (column_id IS NULL))
);

CREATE INDEX tasks_workspace_tray ON tasks (workspace_id, tray, position) WHERE deleted_at IS NULL;
CREATE INDEX tasks_story ON tasks (story_id, position) WHERE deleted_at IS NULL;
CREATE INDEX tasks_sprint_column ON tasks (sprint_id, column_id, column_position) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee_open ON tasks (assignee_user_id) WHERE deleted_at IS NULL AND completed_at IS NULL;

-- 記録

CREATE TABLE completions (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  completed_at TEXT NOT NULL,
  completed_by TEXT NOT NULL REFERENCES users (id),
  points INTEGER,
  assignee_user_id TEXT REFERENCES users (id),
  sprint_id TEXT REFERENCES sprints (id),
  category_id TEXT REFERENCES categories (id),
  billing_month TEXT CHECK (billing_month || '-01' IS date(billing_month || '-01')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX completions_workspace_completed ON completions (workspace_id, completed_at);
CREATE INDEX completions_workspace_billing ON completions (workspace_id, billing_month);
CREATE INDEX completions_sprint ON completions (sprint_id);
CREATE INDEX completions_task ON completions (task_id);

CREATE TABLE xp_grants (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL CHECK (
    action IN (
      'task_created', 'task_detailed', 'task_completed', 'review', 'help', 'story_completed', 'epic_reward'
    )
  ),
  task_id TEXT REFERENCES tasks (id),
  story_id TEXT REFERENCES stories (id),
  epic_id TEXT REFERENCES epics (id),
  -- 元の記録は消えうるので外部キーにしない
  completion_id TEXT,
  thank_id TEXT,
  helper_sender_user_id TEXT REFERENCES users (id),
  amount INTEGER NOT NULL,
  reverses_grant_id TEXT REFERENCES xp_grants (id),
  dedupe_key TEXT NOT NULL UNIQUE,
  confirmed_at TEXT NOT NULL
);

CREATE INDEX xp_grants_user_workspace ON xp_grants (user_id, workspace_id);
CREATE INDEX xp_grants_task ON xp_grants (task_id);
CREATE INDEX xp_grants_story ON xp_grants (story_id);
CREATE INDEX xp_grants_epic ON xp_grants (epic_id);
CREATE INDEX xp_grants_reverses ON xp_grants (reverses_grant_id);

CREATE TABLE change_logs (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  workspace_id TEXT REFERENCES workspaces (id),
  actor_user_id TEXT REFERENCES users (id),
  operator TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(changes_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX change_logs_entity ON change_logs (entity_type, entity_id, created_at);
CREATE INDEX change_logs_organization ON change_logs (organization_id, created_at);
CREATE INDEX change_logs_workspace ON change_logs (workspace_id, created_at);
