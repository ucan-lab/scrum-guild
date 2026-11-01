// wrangler.jsonc の triggers.crons が、定期処理の表（src/server/scheduled/index.ts）の式と食い違わないことを確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const root = import.meta.dirname + '/..';

describe('wrangler.jsonc の triggers.crons', () => {
  test('毎分と毎時 0 分の 2 つ', () => {
    const text = readFileSync(`${root}/wrangler.jsonc`, 'utf8');
    const match = /"crons"\s*:\s*(\[[^\]]*\])/.exec(text);
    assert.ok(match, 'triggers.crons が見つからない');
    assert.deepEqual(JSON.parse(match[1]!), ['* * * * *', '0 * * * *']);
  });

  test('設定の式がすべて定期処理の表にある', () => {
    const text = readFileSync(`${root}/src/server/scheduled/index.ts`, 'utf8');
    for (const cron of ['* * * * *', '0 * * * *']) {
      assert.ok(text.includes(`['${cron}',`), `定期処理の表に無い式: ${cron}`);
    }
  });
});
