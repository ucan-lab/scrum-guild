-- Migration number: 0015	2026-11-01T00:00:00.000Z
-- 会員登録の往復の印（開始の GET に ?signup=1 が付いた往復だけ 1）。戻り先の completeLogin が読む。

ALTER TABLE oauth_states ADD COLUMN is_signup INTEGER NOT NULL DEFAULT 0 CHECK (is_signup IN (0, 1));
