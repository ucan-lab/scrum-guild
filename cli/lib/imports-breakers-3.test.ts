// cli/** から src/ への import を止める eslint の規則（Issue #582 の前提「cli/** から src/ への import は eslint の no-restricted-imports で止める」）を、
// 一時ファイルを作らずに lintText で崩しにいく
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function restricted(code: string, filePath = 'cli/lib/probe.ts'): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath: `${root}/${filePath}` });
  return result!.messages.some((message) => message.ruleId === 'no-restricted-imports');
}

describe('cli/ から src/ に届く import を止める', () => {
  const reaching = [
    "import { operations } from '../../src/shared/operations/index.ts';",
    "import type { AnyOperationDefinition } from '../../src/shared/operations/define.ts';",
    "export { operations } from '../../src/shared/operations/index.ts';",
    "import { x } from './../../src/lib/api.ts';",
    "import { x } from '../src/lib/api.ts';",
  ];
  for (const code of reaching) {
    test(code, async () => {
      assert.equal(await restricted(code), true);
    });
  }

  test('cli/sg.ts（入口）から ../src/ も止める', async () => {
    assert.equal(await restricted("import { x } from '../src/shared/operations/index.ts';", 'cli/sg.ts'), true);
  });

  // $lib は SvelteKit の別名で src/lib を指す。型だけの import は node の型の除去で消えるので、実行でも落ちずに src/ に届く
  test('$lib（src/lib の別名）からの型の import も止める', async () => {
    assert.equal(await restricted("import type { ApiFailure } from '$lib/api.ts';"), true);
  });
});

describe('src/ に届かない import は止めない', () => {
  for (const code of [
    "import { main } from './main.ts';",
    "import { x } from './srcx.ts';",
    "import { x } from '../lib/source.ts';",
    "import { readFile } from 'node:fs/promises';",
  ]) {
    test(code, async () => {
      assert.equal(await restricted(code), false);
    });
  }
});
