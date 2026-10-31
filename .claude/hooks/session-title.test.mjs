// node --test .claude/hooks/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { issueNumberOf, pickPr, titleFor } from './session-title-rules.mjs';

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
  test('0 始まりと桁あふれの数字は Issue の番号にしない', () => {
    assert.equal(issueNumberOf('0-x'), undefined);
    assert.equal(issueNumberOf('0661-x'), undefined);
    assert.equal(issueNumberOf('99999999999999999999-x'), undefined);
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
  test('Issue が無い PR は PR 番号とそのタイトル', () => {
    assert.equal(titleFor({ pr: { number: 7, title: '直す' } }), 'PR #7 直す');
  });
  test('改行と連続する空白を詰める', () => {
    assert.equal(titleFor({ issueNumber: 1, issueTitle: 'a\n  b' }), '#1 a b');
  });
  test('制御文字と書式の文字を取り除く（端末とクリップボードに渡るため）', () => {
    const evil = 'a\u001b[201~\u0007b‮c​d\u0085e\u007ff';
    assert.equal(titleFor({ issueNumber: 1, issueTitle: evil }), '#1 a[201~bcdef');
  });
  test('書式の文字をはさんだ空白も1つに詰める', () => {
    assert.equal(titleFor({ issueNumber: 1, issueTitle: 'a ​ b' }), '#1 a b');
  });
  test('題が書式の文字だけなど、空になるときは名前を出さない', () => {
    assert.equal(titleFor({ issueNumber: 1, issueTitle: '​‮' }), '');
    assert.equal(titleFor({ issueNumber: 1, issueTitle: '​', pr: { number: 2, title: 'x' } }), '');
    assert.equal(titleFor({ pr: { number: 2, title: '​' } }), '');
  });
  test('長いタイトルは 80 文字に切る', () => {
    const title = titleFor({ issueNumber: 1, issueTitle: 'あ'.repeat(200) });
    assert.equal([...title].length, 80);
    assert.ok(title.endsWith('…'));
  });
  test('絵文字が切り口にまたがっても、孤立したサロゲートを残さない', () => {
    const title = titleFor({ issueNumber: 1, issueTitle: 'a'.repeat(73) + '😀😀😀' });
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(title));
    assert.ok([...title].length <= 80);
    assert.equal([...titleFor({ issueNumber: 1, issueTitle: '😀'.repeat(60) })].length, 60 + 3);
  });
});

describe('pickPr', () => {
  test('開いている PR を先に使う', () => {
    assert.deepEqual(pickPr([{ number: 9, state: 'CLOSED' }, { number: 8, state: 'OPEN' }]), { number: 8, state: 'OPEN' });
  });
  test('fork の同名ブランチの PR は使わない', () => {
    const list = [{ number: 9, state: 'OPEN', isCrossRepository: true }, { number: 8, state: 'CLOSED', isCrossRepository: false }];
    assert.equal(pickPr(list).number, 8);
    assert.equal(pickPr([{ number: 9, state: 'OPEN', isCrossRepository: true }]), undefined);
  });
  test('開いているものが無ければ先頭、空なら undefined', () => {
    assert.equal(pickPr([{ number: 9, state: 'MERGED' }, { number: 8, state: 'CLOSED' }]).number, 9);
    assert.equal(pickPr([]), undefined);
    assert.equal(pickPr(undefined), undefined);
  });
});

describe('session-title.mjs（本物の git と偽の gh）', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'session-title-')));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'gh-calls');
  mkdirSync(bin);
  // gh issue view は題を返す。gh pr list は GH_PR_LIST（無ければ失敗）を返す
  writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'echo "$*" >>"$GH_CALLS"',
      'if [ "$1 $2" = "issue view" ]; then echo "$GH_ISSUE_TITLE"; exit 0; fi',
      'if [ "$1 $2" = "pr list" ]; then [ -n "${GH_PR_LIST:-}" ] || exit 1; echo "$GH_PR_LIST"; exit 0; fi',
      'exit 1',
    ].join('\n'),
  );
  chmodSync(path.join(bin, 'gh'), 0o755);

  const repoOn = (branch) => {
    const dir = path.join(root, `repo-${branch.replace(/\W/g, '_')}`);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', '-b', branch, dir]);
    return dir;
  };
  const start = (input, env = {}) => {
    writeFileSync(calls, '');
    const r = spawnSync('node', [script], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_CALLS: calls, GH_ISSUE_TITLE: '招待する', ...env },
    });
    return { ...r, calls: readFileSync(calls, 'utf8').trim() };
  };
  const titleOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.sessionTitle;

  test('PR が無ければ `#番号 題` を SessionStart の形で返す', () => {
    const r = start({ cwd: repoOn('123-invite') }, { GH_PR_LIST: '[]' });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: '#123 招待する' } });
  });
  test('PR があれば `#番号 PR #n 題`', () => {
    const r = start({ cwd: repoOn('124-invite') }, { GH_PR_LIST: '[{"number":9,"state":"CLOSED"},{"number":8,"state":"OPEN"}]' });
    assert.equal(titleOf(r), '#124 PR #8 招待する');
  });
  test('PR の取得に失敗しても、Issue の題で名前を付ける', () => {
    const r = start({ cwd: repoOn('125-invite') });
    assert.equal(titleOf(r), '#125 招待する');
  });
  test('session_title があれば、番号付きのブランチでも何も出さず gh も呼ばない', () => {
    const r = start({ cwd: repoOn('126-invite'), session_title: '手で付けた名前' }, { GH_PR_LIST: '[]' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.calls, '');
  });
  test('番号の無いブランチでは何も出さず gh も呼ばない', () => {
    const r = start({ cwd: repoOn('main') }, { GH_PR_LIST: '[]' });
    assert.equal(r.stdout, '');
    assert.equal(r.calls, '');
  });
  test('Issue の題が引けなければ何も出さずに終わる', () => {
    const r = start({ cwd: repoOn('127-invite') }, { GH_ISSUE_TITLE: '' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
  test('git の外では何も出さずに終わる', () => {
    const r = start({ cwd: '/' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
