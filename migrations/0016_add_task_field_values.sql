-- Migration number: 0016 	 2026-11-01T00:00:00.000Z
-- タスクの決まった欄の中身（#173）。列と制約は docs/data-model.md の task_field_values の写し。組織の中の表。
-- 広げる変更（表を足す）で、前の版のコードはこの表を読み書きしない。行が無い欄が未記入で、空にしたら行を消す（value_md は空を持たない）。
-- 欄（detail_fields）は論理削除だけで、削除した欄の値の行は残す。タスクも物理削除しないので、外部キーが先の行の物理削除を止めることはない。
-- 本文の長さの CHECK は tasks.body_md と同じ上限（100000）で、アプリが守る 10000 字より広くしてある。主キーの先頭の task_id が、タスクへの外部キーの検査と
-- タスクごとの読み出しを引く。field_id は detail_fields を指し、主キーの2番目なので外部キーの検査（欄の物理削除、組織を消すとき）には先頭の列の索引が
-- 使えない。updated_by も users を指すので、どちらも外部キーの検査の索引を足す。

CREATE TABLE task_field_values (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  field_id TEXT NOT NULL REFERENCES detail_fields (id),
  value_md TEXT NOT NULL CHECK (length(value_md) BETWEEN 1 AND 100000),
  updated_by TEXT NOT NULL REFERENCES users (id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, field_id)
);

CREATE INDEX task_field_values_field_id ON task_field_values (field_id);
CREATE INDEX task_field_values_updated_by ON task_field_values (updated_by);
