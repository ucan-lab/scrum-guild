-- Migration number: 0006 	 2026-10-27T03:12:08.417Z
-- タスクのコメント（#171）。列と制約は docs/data-model.md の comments の写し。広げる変更（表を足すだけ）で、前の版のコードは読まない。
-- 削除は論理削除で、本文を空にして deleted_at と deleted_by を書く。消したら中身がどこにも残らないよう、消した行の本文は空、
-- 消していない行の本文は空でないことを CHECK で守る。編集の前の本文は残さない（edited_at だけを書く）。
-- 一覧はタスクごとに created_at, id の順で読むので、索引にも id まで並べる（カーソルの並びに id を使う）。
-- author_user_id と deleted_by は users を指すので、外部キーの検査の索引を持つ（deleted_by は空にできるので部分索引）

CREATE TABLE comments (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  author_user_id TEXT NOT NULL REFERENCES users (id),
  body_md TEXT NOT NULL CHECK (length(body_md) <= 100000),
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CHECK ((deleted_at IS NULL) = (body_md <> ''))
);

CREATE INDEX comments_task ON comments (task_id, created_at, id);
CREATE INDEX comments_author_user ON comments (author_user_id);
CREATE INDEX comments_deleted_by ON comments (deleted_by) WHERE deleted_by IS NOT NULL;
