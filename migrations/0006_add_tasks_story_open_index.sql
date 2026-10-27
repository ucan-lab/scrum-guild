-- Migration number: 0006 	 2026-10-27T03:00:00.000Z
-- バックログの木（backlog-tree、#165）のストーリーの下の未完了のタスクを引く部分索引。docs/data-model.md の tasks の索引の写し。
-- tasks_story（story_id, position。削除していない行）は完了したタスクも持つので、完了が積もるほど、未完了の行を探して読み飛ばす行が増える。
-- 未完了の行だけを持たせ、ストーリーごとに未完了の行だけへ届く（測った数は docs/data-model.md の tasks の節）。
-- 問い合わせは deleted_at IS NULL と completed_at IS NULL を文字のまま書く（Kysely の is null は束縛の値にならない）

CREATE INDEX tasks_story_open ON tasks (story_id, position) WHERE deleted_at IS NULL AND completed_at IS NULL;
