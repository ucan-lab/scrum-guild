-- Migration number: 0010 	 2026-10-29T12:00:00.000Z
-- パスワードの資格情報の表（#256）。列と制約は docs/data-model.md の password_credentials の写し。共通の表。
-- 広げる変更（表を足す）で、前の版のコードはこの表を読み書きしない。
-- login_subject は手段 password の中の ID（発行した UUID）で、account_logins の (password, login_subject) に当たる。
-- メールアドレスはそろえた形（src/shared/email.ts）で、共通の DB で一意にする。UNIQUE の索引がログインの引きを兼ねる。
-- password_hash は自己記述の文字列（方式、反復回数、塩、鍵。src/server/auth/password-hash.ts）。形は CHECK で縛り、
-- 平文のパスワードを入れる取り違えを、DB の写しから読める形で残さない。

CREATE TABLE password_credentials (
  login_subject TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND email GLOB '?*@?*'),
  password_hash TEXT NOT NULL CHECK (password_hash GLOB 'pbkdf2-sha256$[1-9]*$?*$?*'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  password_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
