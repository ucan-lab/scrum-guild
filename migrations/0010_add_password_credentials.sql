-- Migration number: 0010 	 2026-10-29T12:00:00.000Z
-- パスワードのログインの資格情報の表（#256）。列と制約は docs/data-model.md の password_credentials の写し。
-- 広げる変更（共通の表を足す）で、前の版のコードはこの表を読み書きしない。
-- users と invitations の login_email の CHECK を password に広げるのは #257（0001 のまとめ直し）

CREATE TABLE password_credentials (
  login_subject TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  password_hash TEXT NOT NULL CHECK (password_hash GLOB 'pbkdf2-sha256$*'),
  password_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
