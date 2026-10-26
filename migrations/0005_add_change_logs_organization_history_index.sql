-- Migration number: 0005 	 2026-10-26T02:57:32.038Z
-- 組織の変更の履歴（organization-history、#193）の部分索引。docs/data-model.md の change_logs の「組織の変更の履歴」の写し。
-- 履歴に出す行（ワークスペースの外の行と、ワークスペースの作成・終了・再開）だけを持つので、ワークスペースの中の行（タスクなど、
-- 履歴の大半）を読み飛ばさずに、組織ごとに新しい順の50件へ届く。id まで並べるので、同じ日時の並べ替えも索引の中で済む。
-- 問い合わせは、この WHERE と同じ式を文字のまま（束縛の値にせず）書く。SQLite は、問い合わせの条件が索引の条件を含むと
-- 示せたときだけ部分索引を使い、束縛の値の入った式からは示せない（src/server/operations/organization-history.ts）

CREATE INDEX change_logs_organization_history ON change_logs (organization_id, created_at, id)
  WHERE workspace_id IS NULL OR (entity_type = 'workspace' AND action IN ('create', 'close', 'reopen'));
