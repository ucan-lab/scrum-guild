import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isDocsOnly, migrationFiles } from './ci.ts';

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
    assert.equal(isDocsOnly(['', '  ']), false);
  });

  test('前後の空白と空行を無視する', () => {
    assert.equal(isDocsOnly(['docs/a.md', '', ' HANDOFF.md ']), true);
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
