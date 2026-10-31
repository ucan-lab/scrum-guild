-- Migration number: 0012 	 2026-10-31T06:00:00.000Z
-- API トークンの表（#580）。列と制約は docs/data-model.md の api_tokens の写し。共通の表。
-- 広げる変更（表を足す）で、前の版のコードはこの表を読み書きしない。account_id は accounts を指し、索引は sessions と同じ。
-- token_hash は sessions.token_hash と同じ CHECK（SHA-256 の小文字の16進）。ハッシュする前の値を入れる取り違えを DB で止める。
-- expires_at は NOT NULL で、発行から90日以内（上限はアプリが守る。使っても延ばさない）。
-- last_used_at は一度も使っていなければ NULL。revoked_at は取り消した日時で、取り消していなければ NULL。

CREATE TABLE api_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX api_tokens_account_id ON api_tokens (account_id);
