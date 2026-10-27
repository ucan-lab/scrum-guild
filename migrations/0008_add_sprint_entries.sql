-- Migration number: 0008 	 2026-10-27T09:00:00.000Z
-- タスクのスプリントへの出し入れ（#238）。列と制約は docs/data-model.md の sprint_entries と completions の写し。
-- 広げる変更（表と、空にできる列と、一意でない索引を足す）で、前の版のコードはどちらも読まない。
-- sprint_entries は、タスクとスプリントの所属の履歴。入っている間は ended_at と outcome が空で、1つのタスクが入っている行は1つ
-- （tasks.sprint_id と一致させる）。出たら ended_at と outcome（completed、carried_over、removed）を同時に書く。
-- ワークスペースの中の表なので workspace_id を持ち、読み書きはどれもワークスペースで絞る（スプリントの行は (workspace_id, sprint_id) で引く）。
-- completions.previous_column_id は、スプリントの中で完了したときに、完了の前にいた列。スプリントの外の完了では空。
-- 前の版のコードは sprints、tasks、board_columns を物理削除しないので、足した外部キーが前の版の書き込みを止めることはない。
-- added_by は users を指すので、外部キーの検査の索引を持つ。previous_column_id の検査の索引は空の行を書かない部分索引

CREATE TABLE sprint_entries (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  sprint_id TEXT NOT NULL REFERENCES sprints (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL REFERENCES users (id),
  ended_at TEXT,
  outcome TEXT CHECK (outcome IN ('completed', 'carried_over', 'removed')),
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
);

CREATE UNIQUE INDEX sprint_entries_task_open ON sprint_entries (task_id) WHERE ended_at IS NULL;
CREATE INDEX sprint_entries_workspace_sprint ON sprint_entries (workspace_id, sprint_id);
CREATE INDEX sprint_entries_task ON sprint_entries (task_id);
CREATE INDEX sprint_entries_added_by ON sprint_entries (added_by);

ALTER TABLE completions ADD COLUMN previous_column_id TEXT REFERENCES board_columns (id);

CREATE INDEX completions_previous_column ON completions (previous_column_id) WHERE previous_column_id IS NOT NULL;
