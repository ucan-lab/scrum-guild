import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ciOkVerdict, isDocsOnly, needsDevBuild, migrationFiles, parseNulSeparated, type Needs } from './ci.ts';

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
    'seed/sessions.ts',
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
      ['dev_build が無ければ偽として見る', withDev('false', undefined, 'skipped'), true],
      ['文書だけなら dev_build が真でも skipped', withDev('true', 'true', 'skipped', 'skipped'), true],
      ['文書だけで e2e-dev が success', withDev('true', 'false', 'success', 'skipped'), false],
      ['dev_build が偽でも、ほかの重いジョブは success が要る', withDev('false', 'false', 'skipped', 'skipped'), false],
    ];
    for (const [name, input, ok] of devCases) {
      test(name, () => {
        assert.equal(ciOkVerdict(input).ok, ok);
      });
    }

    test('dev_build はほかのジョブの期待を変えない', () => {
      const input: Needs = {
        changes: { result: 'success', outputs: { docs_only: 'false', dev_build: 'false' } },
        e2e: { result: 'skipped' },
      };
      assert.equal(ciOkVerdict(input).ok, false);
    });
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
