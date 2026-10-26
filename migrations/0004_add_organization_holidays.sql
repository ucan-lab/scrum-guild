-- Migration number: 0004 	 2026-10-25T23:14:47.578Z
-- 組織の休日（#194）。列と制約は docs/data-model.md の organization_holidays の写し。積載量（#66）が稼働しない日として読む
-- 日付は 2000〜2099 年だけ（貼り付けの年の誤り、1926-11-03 や 2206-11-03 を止める）。名前は空の文字列を持たず、空は NULL
-- 主キーの先頭の organization_id が、組織への外部キーの検査と組織ごとの一覧を引く。created_by は users を指すので、外部キーの検査の索引を足す

CREATE TABLE organization_holidays (
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  holiday_on TEXT NOT NULL CHECK (holiday_on IS date(holiday_on) AND holiday_on BETWEEN '2000-01-01' AND '2099-12-31'),
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 40),
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, holiday_on)
);

CREATE INDEX organization_holidays_created_by ON organization_holidays (created_by);
