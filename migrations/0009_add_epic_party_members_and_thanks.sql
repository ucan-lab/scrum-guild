-- エピックの討伐隊と感謝の表（#265）。列と制約は docs/data-model.md の epic_party_members と thanks の写し。
-- 広げる変更（表と一意でない索引を足す）で、前の版のコードはどちらの表も読み書きしない。
-- 討伐隊と感謝の表を同じファイルにするのは、#65 の子でマイグレーションを持つのをこの Issue だけにするため（thanks を読み書きするのは #273 から）。
-- 外部キーを持つ子の表だけを足し、前の版のコードが物理削除する親は無い（epics、tasks、users、workspaces は論理削除か、削除しない）ので、
-- 新しい版が書いた子の行が前の版の書き込みを止めることはない。
-- epic_party_members は抜けたら行を消す。epic_id と user_id の組で一意で、主キーの索引が epic_id での引きを兼ねる。
-- どちらの表も、外部キーの検査のために users を指す列に索引を持つ。

CREATE TABLE epic_party_members (
  epic_id TEXT NOT NULL REFERENCES epics (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  joined_via TEXT NOT NULL CHECK (joined_via IN ('self', 'assigned', 'task_assignee')),
  added_by TEXT NOT NULL REFERENCES users (id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (epic_id, user_id)
);

CREATE INDEX epic_party_members_user ON epic_party_members (user_id);
CREATE INDEX epic_party_members_added_by ON epic_party_members (added_by);

CREATE TABLE thanks (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  sender_user_id TEXT NOT NULL REFERENCES users (id),
  recipient_user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  CHECK (sender_user_id <> recipient_user_id)
);

CREATE UNIQUE INDEX thanks_task_recipient ON thanks (task_id, recipient_user_id);
CREATE INDEX thanks_recipient_user ON thanks (recipient_user_id);
CREATE INDEX thanks_sender_user ON thanks (sender_user_id);
