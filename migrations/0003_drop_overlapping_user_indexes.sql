-- Migration number: 0003 	 2026-10-25T21:57:15.879Z
-- 0002 で足した外部キーの検査の索引と重なる、0001 の部分索引を片づける
-- memberships_user_current（user_id WHERE left_at IS NULL）は消す。今の所属を引く文は SQLite が memberships_user_left（user_id、left_at）を選び、こちらは使われないため
-- tasks_assignee_user は (assignee_user_id, deleted_at, completed_at) WHERE assignee_user_id IS NOT NULL に張り直す。担当の未完了のタスクを引く文（assignee_user_id = ? と deleted_at IS NULL と completed_at IS NULL）は SQLite が 0002 の tasks_assignee_user を選び、完了した行と消した行まで読むので、3列とも索引で絞れるようにするため。先頭の列なので外部キーの検査にも使える
-- tasks_assignee_open（assignee_user_id WHERE deleted_at IS NULL AND completed_at IS NULL）は、張り直した tasks_assignee_user が同じ文を引くので消す

DROP INDEX memberships_user_current;

DROP INDEX tasks_assignee_user;
CREATE INDEX tasks_assignee_user ON tasks (assignee_user_id, deleted_at, completed_at) WHERE assignee_user_id IS NOT NULL;

DROP INDEX tasks_assignee_open;
