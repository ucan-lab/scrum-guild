-- Migration number: 0004 	 2026-10-25T23:14:47.578Z
-- 組織の休日（#194）。列と制約は docs/data-model.md の organization_holidays の写し。積載量（#66）が稼働しない日として読む
-- 主キーの先頭の organization_id が、組織への外部キーの検査と組織ごとの一覧を引く。created_by は users を指すので、外部キーの検査の索引を足す

CREATE TABLE organization_holidays (
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  holiday_on TEXT NOT NULL CHECK (holiday_on IS date(holiday_on)),
  name TEXT CHECK (name IS NULL OR length(name) <= 40),
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, holiday_on)
);

CREATE INDEX organization_holidays_created_by ON organization_holidays (created_by);
