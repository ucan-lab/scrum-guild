// seed の同意（#648）を data.sql の文面から崩す。scripts/seed.test.ts が見ない整合:
// 全アカウントの同意（セッションの無いアカウントも）、外部キーの順、unconsented が組織に属さないこと
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { SEED_SESSIONS } from '../seed/sessions.ts';

const data = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
const ID = /'(019a0000-[0-9a-f-]+)'/g;
const UNCONSENTED = SEED_SESSIONS.unconsented.accountId;

// INSERT INTO <table> の文ごとの、先頭の列（アカウントの ID）と文の位置
function insertsInto(table: string): { id: string; at: number }[] {
  const statements = [...data.matchAll(new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b[^;]*;`, 'gi'))];
  return statements.flatMap((statement) =>
    [...statement[0].matchAll(/^\s*\('(019a0000-[0-9a-f-]+)'/gm)].map(([, id]) => ({ id: id!, at: statement.index })),
  );
}

describe('seed の同意の整合', () => {
  const accounts = insertsInto('accounts');

  test('unconsented 以外の data.sql のアカウントは、すべて同意の行を持つ（セッションが無くても）', () => {
    const consented = new Set(insertsInto('account_consents').map((row) => row.id));
    const missing = accounts.map((row) => row.id).filter((id) => id !== UNCONSENTED && !consented.has(id));
    assert.deepEqual(missing, []);
    assert.ok(!consented.has(UNCONSENTED));
  });

  test('同意の行のアカウントは、その文より前の accounts の INSERT にある（外部キーの順）', () => {
    for (const consent of insertsInto('account_consents')) {
      const defined = accounts.find((account) => account.id === consent.id);
      assert.ok(defined !== undefined, `${consent.id} が accounts に無い`);
      assert.ok(defined.at < consent.at, `${consent.id} の accounts が同意の行より後`);
    }
  });

  test('unconsented のアカウントは、accounts とログインの 2 か所だけに現れ、組織にもワークスペースにも入らない', () => {
    const appearances = [...data.matchAll(ID)].filter(([, id]) => id === UNCONSENTED);
    assert.equal(appearances.length, 2);
  });
});
