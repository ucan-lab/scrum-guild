-- Migration number: 0014	2026-11-01T00:00:00.000Z
-- 会員が作った組織の作成者と、お試しの期限（運用者が作る組織では NULL）。

ALTER TABLE organizations ADD COLUMN created_by_account_id TEXT REFERENCES accounts (id);
ALTER TABLE organizations ADD COLUMN trial_ends_on TEXT CHECK (trial_ends_on IS date(trial_ends_on));

CREATE INDEX organizations_created_by_account_id
  ON organizations (created_by_account_id)
  WHERE created_by_account_id IS NOT NULL;
