// 入口を守る ESLint の規則（eslint.config.db-entry.js）の、運用者の道具だけの関数（reassignOrganizationAdmin）を崩すテスト。
// scripts/eslint-db-entry.test.ts の手口（import、別名、export from、名前空間の . と ['...']、動的な import の取り出し）に無い、
// 文字列のリテラルでキーを渡してプロパティを読む関数（D1 の binding では Reflect.get と Object.getOwnPropertyDescriptor を止めている）を確かめる
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { ESLint } from 'eslint';

const RULE = 'db-entry/guard';

let eslint: ESLint;
before(() => {
  eslint = new ESLint({ cwd: import.meta.dirname + '/..' });
});

async function violations(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result);
  const fatal = result.messages.filter((message) => message.fatal);
  assert.deepEqual(fatal, [], `${filePath} を読めない: ${code}`);
  return result.messages.filter((message) => message.ruleId === RULE).length;
}

describe('reassignOrganizationAdmin を、プロパティを読む関数で名前空間から取り出す', () => {
  const forms: Record<string, string> = {
    "Reflect.get(db, 'reassignOrganizationAdmin')": `import * as db from '../db/index.ts'; export const a = Reflect.get(db, 'reassignOrganizationAdmin');`,
    "Object.getOwnPropertyDescriptor(db, 'reassignOrganizationAdmin')": `import * as db from '../db/index.ts'; export const a = Object.getOwnPropertyDescriptor(db, 'reassignOrganizationAdmin')?.value;`,
    '動的な import の Reflect.get': `export const a = Reflect.get(await import('../db/index.ts'), 'reassignOrganizationAdmin');`,
  };

  for (const [name, code] of Object.entries(forms)) {
    test(`src/server/operations/operator-admin.ts: ${name} で落ちる`, async () => {
      assert.ok((await violations('src/server/operations/operator-admin.ts', code)) >= 1, `落ちなかった: ${name}`);
    });
  }
});
