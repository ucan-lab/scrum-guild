-- Migration number: 0013	2026-11-01T00:00:00.000Z
-- 利用規約とプライバシーポリシーへの同意の記録（#647）。共通の表。行は追記だけで、最新の同意を読む。

CREATE TABLE account_consents (
  account_id TEXT NOT NULL REFERENCES accounts (id),
  terms_version TEXT NOT NULL CHECK (terms_version GLOB '????-??-??'),
  privacy_version TEXT NOT NULL CHECK (privacy_version GLOB '????-??-??'),
  consented_at TEXT NOT NULL,
  PRIMARY KEY (account_id, terms_version, privacy_version, consented_at)
);

CREATE INDEX account_consents_account_consented_at ON account_consents (account_id, consented_at);
