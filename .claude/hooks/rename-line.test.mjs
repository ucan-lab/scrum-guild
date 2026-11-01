// node --test .claude/hooks/*.test.mjs
// rename-session の rename-line.mjs。偽の gh と pbcopy を PATH の先頭に置き、子プロセスで走らせる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 見えない文字は、整形や編集で消えても気づけないので、生で書かずコードポイントで組む
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'rename-session', 'rename-line.mjs');

describe('rename-line.mjs（偽の gh と pbcopy）', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rename-line-')));
  after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const ghCalls = path.join(root, 'gh-calls');
  const clipboard = path.join(root, 'clipboard');
  mkdirSync(bin);
  const stub = (name, lines) => {
    writeFileSync(path.join(bin, name), ['#!/usr/bin/env bash', ...lines].join('\n'));
    chmodSync(path.join(bin, name), 0o755);
  };
  stub('gh', [
    'echo "$*" >>"$GH_CALLS"',
    '[ -z "${GH_FAIL:-}" ] || exit 1',
    '[ "$1" = "api" ] || exit 1',
    '[ "$3 $4" = "--jq .title" ] || exit 1',
    'case "$2" in',
    '  repos/{owner}/{repo}/issues/*) echo "$GH_ISSUE_TITLE"; exit 0;;',
    '  repos/{owner}/{repo}/pulls/*) echo "$GH_PR_TITLE"; exit 0;;',
    'esac',
    'exit 1',
  ]);
  stub('pbcopy', ['cat >"$PB_OUT"', 'exit "${PB_EXIT:-0}"']);

  const run = (args, env = {}) => {
    writeFileSync(ghCalls, '');
    writeFileSync(clipboard, '');
    const r = spawnSync('node', [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_CALLS: ghCalls,
        PB_OUT: clipboard,
        GH_ISSUE_TITLE: '招待する',
        GH_PR_TITLE: 'feat: 招待',
        ...env,
      },
    });
    return { ...r, ghCalls: readFileSync(ghCalls, 'utf8'), clipboard: readFileSync(clipboard, 'utf8') };
  };

  describe('名前の形', () => {
    test('--issue だけなら PR の前の形', () => {
      const r = run(['--issue', '661']);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '/rename #661 招待する\n');
    });
    test('--issue と --pr なら PR の後の形で、題は Issue のまま', () => {
      const r = run(['--issue', '661', '--pr', '663']);
      assert.equal(r.stdout, '/rename #661 PR #663 招待する\n');
      assert.equal(r.ghCalls, 'api repos/{owner}/{repo}/issues/661 --jq .title\n', 'Issue の題だけを REST で引き、PR のタイトルは引かない');
    });
    test('--pr だけなら Issue の無い PR の形で、PR のタイトルを使う', () => {
      const r = run(['--pr', '663']);
      assert.equal(r.stdout, '/rename PR #663 feat: 招待\n');
      assert.equal(r.ghCalls, 'api repos/{owner}/{repo}/pulls/663 --jq .title\n', 'PR のタイトルだけを REST で引く');
    });
    test('題の制御文字は取り除かれる', () => {
      const r = run(['--issue', '661'], { GH_ISSUE_TITLE: `a\u001b[201~${RLO}b` });
      assert.equal(r.stdout, '/rename #661 a[201~b\n');
    });
  });

  describe('引数の検証', () => {
    const fails = (args, message) => {
      const r = run(args);
      assert.equal(r.status, 1, `${args.join(' ')} は失敗する`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(message), `標準エラーに「${message}」が無い: ${r.stderr}`);
      assert.equal(r.ghCalls, '', 'gh を呼ばない');
      assert.equal(r.clipboard, '', 'クリップボードに入れない');
    };
    test('引数が無い', () => fails([], '--issue か --pr'));
    test('値の無いフラグ（末尾）', () => fails(['--issue', '661', '--pr'], '--pr に値がありません'));
    test('値の位置に別のフラグ', () => fails(['--issue', '--copy'], '--issue に値がありません'));
    test('--issue=661 の形は受け付けない', () => fails(['--issue=661'], '未知の引数です'));
    test('未知の引数', () => fails(['--issue', '661', '--force'], '未知の引数です'));
    test('正の整数でない値', () => {
      fails(['--issue', 'abc'], '正の整数');
      fails(['--issue', '0'], '正の整数');
      fails(['--pr', '-1'], '正の整数');
    });
    test('同じフラグの重複', () => fails(['--issue', '1', '--issue', '2'], '2回渡されています'));
  });

  describe('gh の失敗', () => {
    test('Issue の題を引けなければ失敗し、何も出さない', () => {
      const r = run(['--issue', '661'], { GH_FAIL: '1' });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes('gh で Issue か PR の題を引けませんでした'));
    });
    test('PR のタイトルを引けなければ失敗し、何も出さない', () => {
      const r = run(['--pr', '663'], { GH_FAIL: '1' });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes('gh で Issue か PR の題を引けませんでした'));
    });
    test('題が書式の文字だけで空になるときは、名前を組み立てられないと失敗する', () => {
      const r = run(['--issue', '661'], { GH_ISSUE_TITLE: ZWSP });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes('名前を組み立てられませんでした'));
    });
  });

  describe('--copy', () => {
    test('標準出力と同じ1行（改行なし）をクリップボードに入れる', () => {
      const r = run(['--issue', '661', '--pr', '663', '--copy']);
      assert.equal(r.status, 0);
      assert.equal(r.clipboard, '/rename #661 PR #663 招待する');
      assert.equal(r.stdout, `${r.clipboard}\n`);
    });
    test('--copy が無ければクリップボードに触れない', () => {
      assert.equal(run(['--issue', '661']).clipboard, '');
    });
    test('pbcopy が失敗したら、行は出したうえで終了コード 1 と理由を返す', () => {
      const r = run(['--issue', '661', '--copy'], { PB_EXIT: '1' });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '/rename #661 招待する\n');
      assert.ok(r.stderr.includes('pbcopy でクリップボードに入れられませんでした'));
    });
  });
});
