-- Migration number: 0011 	 2026-10-30T06:00:00.000Z
-- 経験値の明細の並びと組織の合計（#296）に使う索引。docs/data-model.md の xp_grants の索引の写し。
-- 明細は確定日時と ID の降順で引き、合計は amount を含む索引だけで読む。
-- xp_grants_user_workspace は残す。置き換えに伴う削除は縮める変更なので別の PR で行う。

CREATE INDEX xp_grants_user_confirmed ON xp_grants (user_id, confirmed_at, id);
CREATE INDEX xp_grants_user_workspace_amount ON xp_grants (user_id, workspace_id, amount);

-- 経験値の見込み（experience-summary）。本人が作った未完了で削除していないタスクだけを引く。
-- tasks_created_by は完了済みと削除済みの行も持つので、使い込むほど読む行が増える。
-- 問い合わせは deleted_at IS NULL を文字のまま書く（Kysely の is null は束縛の値にならない）
CREATE INDEX tasks_created_by_open ON tasks (created_by, completed_at) WHERE created_by IS NOT NULL AND deleted_at IS NULL;
