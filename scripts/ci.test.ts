import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import {
  ciOkVerdict,
  countListedTests,
  isDocsOnly,
  needsDevBuild,
  migrationFiles,
  parseNulSeparated,
  REPEAT_TEST_LIMIT,
  repeatFiles,
  repeatVerdict,
  type ListReport,
  type Needs,
} from './ci.ts';

describe('isDocsOnly', () => {
  test('文書の範囲の .md だけなら真', () => {
    assert.equal(
      isDocsOnly([
        'docs/development.md',
        'CLAUDE.md',
        '.claude/skills/pr-create/SKILL.md',
        '.claude/agents/code-reviewer.md',
        '.claude/checklists/multi-tenant.md',
        '.github/ISSUE_TEMPLATE/plan.md',
      ]),
      true,
    );
  });

  test('範囲の外のファイルが1つでも混ざれば偽', () => {
    assert.equal(isDocsOnly(['docs/development.md', 'src/server/app.ts']), false);
  });

  test('範囲の中でも .md 以外は文書に数えない', () => {
    assert.equal(isDocsOnly(['docs/build.sh']), false);
    assert.equal(isDocsOnly(['.claude/skills/x/scripts/run.mjs']), false);
    assert.equal(isDocsOnly(['.github/ISSUE_TEMPLATE/config.yml']), false);
  });

  test('範囲の外に置いた .md は文書に数えない', () => {
    assert.equal(isDocsOnly(['src/README.md']), false);
    assert.equal(isDocsOnly(['README.md']), false);
  });

  test('.claude/ のフックと設定は文書に数えない', () => {
    assert.equal(isDocsOnly(['.claude/hooks/guard-bash.mjs']), false);
    assert.equal(isDocsOnly(['.claude/settings.json']), false);
  });

  test('ISSUE_TEMPLATE 以外の .github/ は文書に数えない', () => {
    assert.equal(isDocsOnly(['.github/workflows/ci.yml']), false);
  });

  test('名前の先頭だけが似たパスは文書に数えない', () => {
    assert.equal(isDocsOnly(['docs-old/a.md', 'CLAUDE.md.bak', 'src/docs/a.md']), false);
  });

  test('一覧が空なら偽', () => {
    assert.equal(isDocsOnly([]), false);
  });

  test('前に空白の付いた名前は、空白を除いた名前と別のファイルとして見る', () => {
    assert.equal(isDocsOnly([' CLAUDE.md']), false);
  });

  test('日本語の名前の文書も文書に数える', () => {
    assert.equal(isDocsOnly(['docs/開発.md']), true);
  });
});

describe('needsDevBuild', () => {
  const runs: string[] = [
    'src/lib/components/TaskEntry.svelte',
    'src/routes/[slug]/w/[id]/+page.svelte',
    'src/lib/focus.svelte.ts',
    'src/shared/vocabulary.ts',
    'src/app.html',
    'e2e/fixtures.ts',
    'package.json',
    'pnpm-lock.yaml',
    'vite.config.ts',
    'playwright.config.ts',
    'scripts/e2e-server.ts',
    'scripts/dev-warnings.ts',
    '.github/workflows/ci.yml',
    // build と e2e のサーバー、CI の用意、e2e が開くデータ
    'scripts/dev.ts',
    'scripts/dev-ports.ts',
    'scripts/write-headers.ts',
    'scripts/db-seed.ts',
    'scripts/headers.ts',
    '.github/actions/setup/action.yml',
    '.github/actions/playwright/action.yml',
    'pnpm-workspace.yaml',
    '.node-version',
    'wrangler.jsonc',
    'tsconfig.json',
    'static/favicon.svg',
    'seed/sessions.ts',
    'seed/data.sql',
  ];
  for (const path of runs) {
    test(`${path} が変われば走らせる`, () => {
      assert.equal(needsDevBuild([path]), true);
    });
  }

  const skips: string[] = [
    'src/server/operations/register.ts',
    'migrations/0001_init.sql',
    'test/operations.test.ts',
    'docs/development.md',
    'scripts/ci.ts',
    '.github/workflows/ai-review.yml',
    '.claude/hooks/guard-bash.mjs',
    'scripts/dev-open.ts',
    'xsrc/lib/a.svelte',
    'package.json.bak',
  ];
  for (const path of skips) {
    test(`${path} だけなら走らせない`, () => {
      assert.equal(needsDevBuild([path]), false);
    });
  }

  test('走らせるファイルが1つでも混ざれば走らせる', () => {
    assert.equal(needsDevBuild(['src/server/index.ts', 'src/lib/a.ts']), true);
  });

  test('一覧が空なら、判定を誤ったとみて走らせる', () => {
    assert.equal(needsDevBuild([]), true);
  });
});

describe('parseNulSeparated', () => {
  test('NUL で区切り、末尾の区切りの後の空を除く', () => {
    assert.deepEqual(parseNulSeparated('docs/開発.md\0 CLAUDE.md\0a\nb.md\0'), [
      'docs/開発.md',
      ' CLAUDE.md',
      'a\nb.md',
    ]);
  });

  test('空の出力は空の一覧', () => {
    assert.deepEqual(parseNulSeparated(''), []);
  });
});

describe('ciOkVerdict', () => {
  function needs(changes: string, docsOnly: string | undefined, ...heavy: string[]): Needs {
    const jobs: Needs = {
      changes: { result: changes, outputs: docsOnly === undefined ? {} : { docs_only: docsOnly } },
    };
    heavy.forEach((result, i) => {
      jobs[`job${i}`] = { result };
    });
    return jobs;
  }

  const cases: [string, Needs, boolean][] = [
    ['文書だけで4つが skipped', needs('success', 'true', 'skipped', 'skipped', 'skipped', 'skipped'), true],
    ['文書以外で4つが success', needs('success', 'false', 'success', 'success', 'success', 'success'), true],
    ['文書だけで1つが success', needs('success', 'true', 'success', 'skipped', 'skipped', 'skipped'), false],
    ['文書以外で skipped が混ざる', needs('success', 'false', 'success', 'skipped', 'success', 'success'), false],
    ['文書以外で failure', needs('success', 'false', 'success', 'failure', 'success', 'success'), false],
    ['文書以外で cancelled', needs('success', 'false', 'cancelled', 'success', 'success', 'success'), false],
    ['docs_only が空なら文書以外として見る', needs('success', '', 'skipped', 'skipped', 'skipped', 'skipped'), false],
    ['docs_only が無ければ文書以外として見る', needs('success', undefined, 'success', 'success'), true],
    ['changes が failure', needs('failure', undefined, 'skipped', 'skipped', 'skipped', 'skipped'), false],
    ['changes が無い', { check: { result: 'success' } }, false],
    ['重いジョブが無い', needs('success', 'false'), false],
  ];

  for (const [name, input, ok] of cases) {
    test(name, () => {
      assert.equal(ciOkVerdict(input).ok, ok);
    });
  }

  describe('開発モードの e2e（e2e-dev）は dev_build で期待が変わる', () => {
    function withDev(docsOnly: string, devBuild: string | undefined, dev: string, other = 'success'): Needs {
      const outputs: Record<string, string> = { docs_only: docsOnly };
      if (devBuild !== undefined) outputs.dev_build = devBuild;
      return { changes: { result: 'success', outputs }, check: { result: other }, 'e2e-dev': { result: dev } };
    }

    const devCases: [string, Needs, boolean][] = [
      ['dev_build が真で success', withDev('false', 'true', 'success'), true],
      ['dev_build が真で skipped', withDev('false', 'true', 'skipped'), false],
      ['dev_build が真で failure', withDev('false', 'true', 'failure'), false],
      ['dev_build が偽で skipped', withDev('false', 'false', 'skipped'), true],
      [
        'dev_build が偽で success（走ったなら通っていればよいが、期待と違う）',
        withDev('false', 'false', 'success'),
        false,
      ],
      ['dev_build が無ければ、判定を誤ったとみて落とす', withDev('false', undefined, 'skipped'), false],
      ['dev_build が真でも偽でもなければ落とす', withDev('false', '', 'skipped'), false],
      ['文書だけなら dev_build が無くても skipped で通す', withDev('true', undefined, 'skipped', 'skipped'), true],
      ['文書だけなら dev_build が真でも skipped', withDev('true', 'true', 'skipped', 'skipped'), true],
      ['文書だけで e2e-dev が success', withDev('true', 'false', 'success', 'skipped'), false],
      ['dev_build が偽でも、ほかの重いジョブは success が要る', withDev('false', 'false', 'skipped', 'skipped'), false],
    ];
    for (const [name, input, ok] of devCases) {
      test(name, () => {
        assert.equal(ciOkVerdict(input).ok, ok);
      });
    }

    test('Object.prototype の名前（toString など）のジョブを、条件付きのジョブと取り違えない', () => {
      for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        const input: Needs = { changes: { result: 'success', outputs: { docs_only: 'false', dev_build: 'false' } } };
        Object.defineProperty(input, name, { value: { result: 'skipped' }, enumerable: true });
        assert.equal(ciOkVerdict(input).ok, false, name);
      }
    });

    test('dev_build はほかのジョブの期待を変えない', () => {
      const input: Needs = {
        changes: { result: 'success', outputs: { docs_only: 'false', dev_build: 'false' } },
        e2e: { result: 'skipped' },
      };
      assert.equal(ciOkVerdict(input).ok, false);
    });
  });

  describe('繰り返す e2e（e2e-repeat）は repeat で期待が変わる', () => {
    function withRepeat(repeat: string | undefined, result: string, docsOnly = 'false'): Needs {
      const outputs: Record<string, string> = { docs_only: docsOnly, dev_build: 'true' };
      if (repeat !== undefined) outputs.repeat = repeat;
      return {
        changes: { result: 'success', outputs },
        check: { result: docsOnly === 'true' ? 'skipped' : 'success' },
        'e2e-dev': { result: docsOnly === 'true' ? 'skipped' : 'success' },
        'e2e-repeat': { result },
      };
    }

    const repeatCases: [string, Needs, boolean][] = [
      ['repeat が真で success', withRepeat('true', 'success'), true],
      ['repeat が真で failure（揺れた）', withRepeat('true', 'failure'), false],
      ['repeat が真で skipped', withRepeat('true', 'skipped'), false],
      ['repeat が偽で skipped', withRepeat('false', 'skipped'), true],
      ['repeat が偽で success', withRepeat('false', 'success'), false],
      ['repeat が無ければ、判定を誤ったとみて落とす', withRepeat(undefined, 'skipped'), false],
      ['repeat が真でも偽でもなければ落とす', withRepeat('', 'skipped'), false],
      ['文書だけなら repeat が無くても skipped で通す', withRepeat(undefined, 'skipped', 'true'), true],
    ];
    for (const [name, input, ok] of repeatCases) {
      test(name, () => {
        assert.equal(ciOkVerdict(input).ok, ok);
      });
    }
  });

  test('通さないときは、期待と違うジョブを理由に挙げる', () => {
    const verdict = ciOkVerdict(needs('success', 'false', 'success', 'failure'));
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /job1=failure/);
  });
});

describe('migrationFiles', () => {
  test('.sql だけを名前の順に返す', () => {
    assert.deepEqual(migrationFiles(['0002_b.sql', '.gitkeep', '0001_a.sql', 'README.md']), [
      '0001_a.sql',
      '0002_b.sql',
    ]);
  });

  test('0件なら空', () => {
    assert.deepEqual(migrationFiles([]), []);
  });
});

describe('repeatFiles', () => {
  test('足したか変えた e2e のテストのファイルだけを、重ねずに名前の順で選ぶ', () => {
    assert.deepEqual(
      repeatFiles([
        'e2e/members.test.ts',
        'src/lib/a.svelte',
        'e2e/fixtures.ts',
        'e2e/helpers.ts',
        'e2e/a11y-check.test.ts',
        'test/operations.test.ts',
        'src/lib/a.test.ts',
        'docs/development.md',
        'e2e/members.test.ts',
      ]),
      ['e2e/a11y-check.test.ts', 'e2e/members.test.ts'],
    );
  });

  test('共通のファイルと画面のコードだけなら空', () => {
    assert.deepEqual(repeatFiles(['e2e/fixtures.ts', 'e2e/operations.ts', 'src/routes/+page.svelte']), []);
  });

  test('空の一覧は空', () => {
    assert.deepEqual(repeatFiles([]), []);
  });

  const bad = [
    'e2e/Members.test.ts',
    'e2e/members test.test.ts',
    'e2e/a\nb.test.ts',
    'e2e/$(id).test.ts',
    'e2e/*.test.ts',
    'e2e/sub/members.test.ts',
    'e2e/メンバー.test.ts',
    'e2e/.test.ts',
  ];
  for (const path of bad) {
    test(`形に合わない名前（${JSON.stringify(path)}）は黙って外さずに落とす`, () => {
      assert.throws(() => repeatFiles(['e2e/members.test.ts', path]), /合わない/);
    });
  }
});

describe('countListedTests と repeatVerdict', () => {
  function report(...files: number[][]): ListReport {
    // ファイルごとに、直下の spec の数と、describe の中の spec の数を並べる
    return {
      suites: files.map(([top, nested = 0]) => ({
        specs: Array.from({ length: top }, () => ({ tests: [{}] })),
        suites: [{ specs: Array.from({ length: nested }, () => ({ tests: [{}] })), suites: [] }],
      })),
      errors: [],
    };
  }

  test('describe の入れ子もたどって数える', () => {
    assert.equal(countListedTests(report([3, 2], [0, 4])), 9);
  });

  test('プロジェクトが2つなら spec ごとに2件と数える', () => {
    assert.equal(countListedTests({ suites: [{ specs: [{ tests: [{}, {}] }] }] }), 2);
  });

  test('suites が無ければ 0 件', () => {
    assert.equal(countListedTests({}), 0);
  });

  test(`上限の ${REPEAT_TEST_LIMIT} 件ちょうどなら回す`, () => {
    assert.deepEqual(repeatVerdict(report([REPEAT_TEST_LIMIT]), 1), { run: true, count: REPEAT_TEST_LIMIT });
  });

  test('上限を1件でも超えたら回さない', () => {
    assert.deepEqual(repeatVerdict(report([REPEAT_TEST_LIMIT, 1]), 2), { run: false, count: REPEAT_TEST_LIMIT + 1 });
  });

  test('ファイルを渡さず 0 件なら回す（--pass-with-no-tests で通る）', () => {
    assert.deepEqual(repeatVerdict(report(), 0), { run: true, count: 0 });
  });

  test('--list がエラーを返したら、回さずに通すのでなく落とす', () => {
    assert.throws(() => repeatVerdict({ suites: [], errors: [{ message: 'SyntaxError' }] }, 1), /エラー/);
  });

  test('ファイルを渡したのに 0 件なら、出力の形が変わったとみて落とす（上限が効かなくなるため）', () => {
    assert.throws(() => repeatVerdict({ suites: [{ specs: [], suites: [] }], errors: [] }, 1), /0 件/);
  });

  test('本物の playwright test --list の出力を、Playwright の数える件数と同じに数える', () => {
    const run = (...args: string[]) =>
      spawnSync('node_modules/.bin/playwright', ['test', '--list', ...args, 'e2e/logout.test.ts'], {
        encoding: 'utf8',
      });
    const json = run('--reporter=json');
    assert.equal(json.status, 0, json.stderr);
    const total = /Total: (\d+) tests?/.exec(run().stdout)?.[1];
    assert.ok(total !== undefined && Number(total) > 0);
    assert.equal(countListedTests(JSON.parse(json.stdout) as ListReport), Number(total));
  });
});

describe('changes.ts --repeat と e2e-repeat-count.ts の出力', () => {
  test('changes.ts --repeat は、#459 で直した e2e のテストのファイルも外さずに繰り返す', () => {
    const result = spawnSync(process.execPath, ['scripts/changes.ts', '--repeat'], {
      input: 'e2e/logout.test.ts\0e2e/login.test.ts\0',
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'repeat=true\nrepeat_files=e2e/login.test.ts e2e/logout.test.ts\n');
    assert.equal(result.stderr, '');
  });

  const node = (script: string, input: string, ...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' });

  test('changes.ts --repeat は repeat と repeat_files の2行だけを出す', () => {
    const result = node(
      'scripts/changes.ts',
      'e2e/login.test.ts\0e2e/fixtures.ts\0e2e/a11y-check.test.ts\0',
      '--repeat',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'repeat=true\nrepeat_files=e2e/a11y-check.test.ts e2e/login.test.ts\n');
  });

  test('changes.ts --repeat は選ぶものが無ければ repeat=false', () => {
    const result = node('scripts/changes.ts', 'src/a.ts\0', '--repeat');
    assert.equal(result.stdout, 'repeat=false\nrepeat_files=\n');
  });

  test('changes.ts --repeat は形に合わない名前で落ち、GITHUB_OUTPUT に何も出さない', () => {
    const result = node('scripts/changes.ts', 'e2e/a b.test.ts\0', '--repeat');
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  });

  const listed = (n: number) =>
    JSON.stringify({ suites: [{ specs: Array.from({ length: n }, () => ({ tests: [{}] })) }], errors: [] });

  test(`e2e-repeat-count.ts は上限の ${REPEAT_TEST_LIMIT} 件まで run=true を出し、注記を出さない`, () => {
    const result = node('scripts/e2e-repeat-count.ts', listed(REPEAT_TEST_LIMIT), 'e2e/a.test.ts');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'run=true\n');
    assert.equal(result.stderr, '');
  });

  test('e2e-repeat-count.ts は上限を超えたら run=false を出し、件数を注記に出す', () => {
    const result = node('scripts/e2e-repeat-count.ts', listed(REPEAT_TEST_LIMIT + 1), 'e2e/a.test.ts');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'run=false\n');
    assert.match(result.stderr, new RegExp(`^::notice title=e2e-repeat::.*${REPEAT_TEST_LIMIT + 1} 件`));
  });

  test('e2e-repeat-count.ts はファイルを渡したのに 0 件なら落とす', () => {
    const result = node('scripts/e2e-repeat-count.ts', listed(0), 'e2e/a.test.ts');
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  });
});
