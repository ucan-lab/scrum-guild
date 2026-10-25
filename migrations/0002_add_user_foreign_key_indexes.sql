-- Migration number: 0002 	 2026-10-25T20:43:03.086Z
-- users.id を指す外部キーの列に、外部キーの検査に使える索引を足す。待っていた users の行を消すとき、子の表を全件読まないようにする
-- 空にできる列は WHERE x IS NOT NULL の部分索引にする。検査の x = ? が条件を満たすので使える。ほかの条件の部分索引（left_at IS NULL など）は使えない
-- xp_grants.user_id は xp_grants_user_workspace の先頭の列なので足さない
-- memberships は (user_id, left_at) にする。今の所属を引く文（user_id と left_at IS NULL）は、SQLite がこちらを選ぶので、2列とも索引で絞れるようにするため

CREATE INDEX workspaces_created_by ON workspaces (created_by);

CREATE INDEX memberships_user_left ON memberships (user_id, left_at);

CREATE INDEX invitations_invited_by ON invitations (invited_by);

CREATE INDEX epics_requester_user ON epics (requester_user_id);
CREATE INDEX epics_created_by ON epics (created_by);
CREATE INDEX epics_completed_by ON epics (completed_by) WHERE completed_by IS NOT NULL;
CREATE INDEX epics_canceled_by ON epics (canceled_by) WHERE canceled_by IS NOT NULL;

CREATE INDEX stories_created_by ON stories (created_by);
CREATE INDEX stories_completed_by ON stories (completed_by) WHERE completed_by IS NOT NULL;

CREATE INDEX sprints_started_by ON sprints (started_by) WHERE started_by IS NOT NULL;
CREATE INDEX sprints_closed_by ON sprints (closed_by) WHERE closed_by IS NOT NULL;

CREATE INDEX tasks_assignee_user ON tasks (assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX tasks_completed_by ON tasks (completed_by) WHERE completed_by IS NOT NULL;
CREATE INDEX tasks_created_by ON tasks (created_by) WHERE created_by IS NOT NULL;

CREATE INDEX completions_completed_by ON completions (completed_by);
CREATE INDEX completions_assignee_user ON completions (assignee_user_id) WHERE assignee_user_id IS NOT NULL;

CREATE INDEX xp_grants_helper_sender_user ON xp_grants (helper_sender_user_id) WHERE helper_sender_user_id IS NOT NULL;

CREATE INDEX change_logs_actor_user ON change_logs (actor_user_id) WHERE actor_user_id IS NOT NULL;
