import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ciOkVerdict, isDocsOnly, migrationFiles, parseNulSeparated, type Needs } from './ci.ts';

describe('isDocsOnly', () => {
  test('CLAUDE.md の例外に挙げた文書だけなら真', () => {
    assert.equal(
      isDocsOnly([
        'docs/development.md',
        'HANDOFF.md',
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
  });

  test('.claude/ のフックと設定は文書に数えない', () => {
    assert.equal(isDocsOnly(['.claude/hooks/guard-bash.mjs']), false);
    assert.equal(isDocsOnly(['.claude/settings.json']), false);
  });

  test('ISSUE_TEMPLATE 以外の .github/ は文書に数えない', () => {
    assert.equal(isDocsOnly(['.github/workflows/ci.yml']), false);
  });

  test('名前の先頭だけが似たパスは文書に数えない', () => {
    assert.equal(isDocsOnly(['docs-old/a.md', 'HANDOFF.md.bak', 'src/docs/a.md']), false);
  });

  test('一覧が空なら偽', () => {
    assert.equal(isDocsOnly([]), false);
  });

  test('前に空白の付いた名前は、空白を除いた名前と別のファイルとして見る', () => {
    assert.equal(isDocsOnly([' HANDOFF.md']), false);
  });

  test('日本語の名前の文書も文書に数える', () => {
    assert.equal(isDocsOnly(['docs/開発.md']), true);
  });
});

describe('parseNulSeparated', () => {
  test('NUL で区切り、末尾の区切りの後の空を除く', () => {
    assert.deepEqual(parseNulSeparated('docs/開発.md\0 HANDOFF.md\0a\nb.md\0'), [
      'docs/開発.md',
      ' HANDOFF.md',
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
