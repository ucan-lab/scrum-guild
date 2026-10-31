// node --test .claude/hooks/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { issueNumberOf, titleFor } from './session-title-rules.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-title.mjs');

describe('issueNumberOf', () => {
  test('ブランチ名の先頭の数字を Issue 番号にする', () => {
    assert.equal(issueNumberOf('52-github-login'), 52);
  });
  test('番号の無いブランチは undefined', () => {
    assert.equal(issueNumberOf('main'), undefined);
    assert.equal(issueNumberOf('claude/fix-login'), undefined);
    assert.equal(issueNumberOf('attribution-off'), undefined);
    assert.equal(issueNumberOf(undefined), undefined);
  });
});

describe('titleFor', () => {
  test('PR が無ければ Issue 番号とタイトル', () => {
    assert.equal(titleFor({ issueNumber: 52, issueTitle: 'GitHub でログインする' }), '#52 GitHub でログインする');
  });
  test('PR があれば PR 番号を挟み、題は Issue のまま', () => {
    const pr = { number: 660, title: 'feat(auth): 使われない' };
    assert.equal(titleFor({ issueNumber: 52, issueTitle: 'GitHub でログインする', pr }), '#52 PR #660 GitHub でログインする');
  });
  test('改行と連続する空白を詰める', () => {
    assert.equal(titleFor({ issueNumber: 1, issueTitle: 'a\n  b' }), '#1 a b');
  });
  test('長いタイトルは 80 文字に切る', () => {
    const title = titleFor({ issueNumber: 1, issueTitle: 'あ'.repeat(200) });
    assert.equal([...title].length, 80);
    assert.ok(title.endsWith('…'));
  });
});

describe('session-title.mjs', () => {
  const start = (input) => spawnSync('node', [script], { input: JSON.stringify(input), encoding: 'utf8' });

  test('既に名前があれば何も出さない（gh を呼ばない）', () => {
    const r = start({ session_title: '手で付けた名前', cwd: '/nonexistent' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
  test('git の外では何も出さずに終わる', () => {
    const r = start({ cwd: '/' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
