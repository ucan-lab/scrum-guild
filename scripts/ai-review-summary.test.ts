import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { MAX_COMMENT_LENGTH, MISSING_SUMMARY, summaryBody, TRUNCATED_NOTE } from './ai-review-summary.ts';

describe('summaryBody', () => {
  test('まとめが無いか空白だけなら、書かずに終わった旨を返す', () => {
    assert.equal(summaryBody(undefined), MISSING_SUMMARY);
    assert.equal(summaryBody(''), MISSING_SUMMARY);
    assert.equal(summaryBody(' \n\t'), MISSING_SUMMARY);
  });

  test('上限ちょうどまでは、そのまま返す', () => {
    const summary = 'あ'.repeat(MAX_COMMENT_LENGTH);
    assert.equal(summaryBody(summary), summary);
  });

  test('上限を超えたら、切り詰めた旨を足して上限に収める', () => {
    const summary = 'a'.repeat(MAX_COMMENT_LENGTH + 1);
    const body = summaryBody(summary);
    assert.equal(body.length, MAX_COMMENT_LENGTH);
    assert.ok(body.endsWith(TRUNCATED_NOTE));
    assert.ok(summary.startsWith(body.slice(0, -TRUNCATED_NOTE.length)));
  });

  test('切り口でサロゲートペアを割らない', () => {
    // 切り口の直前の1文字がサロゲートペアの前半になるよう、絵文字の前に置く文字の数の偶奇を合わせる
    const cut = MAX_COMMENT_LENGTH - TRUNCATED_NOTE.length;
    const prefix = 'a'.repeat((cut - 1) % 2 === 0 ? 2 : 1);
    const summary = prefix + '😀'.repeat(MAX_COMMENT_LENGTH);
    assert.equal(summary.charCodeAt(cut - 1), '😀'.charCodeAt(0));
    const body = summaryBody(summary);
    assert.equal(body.length, MAX_COMMENT_LENGTH - 1);
    const head = body.slice(0, -TRUNCATED_NOTE.length);
    assert.equal(head, prefix + '😀'.repeat((head.length - prefix.length) / 2));
  });

  test('切り口の直前でサロゲートペアが閉じていれば、削らない', () => {
    const cut = MAX_COMMENT_LENGTH - TRUNCATED_NOTE.length;
    const prefix = 'a'.repeat((cut - 1) % 2 === 0 ? 1 : 2);
    const summary = prefix + '😀'.repeat(MAX_COMMENT_LENGTH);
    assert.equal(summary.charCodeAt(cut - 1), '😀'.charCodeAt(1));
    const body = summaryBody(summary);
    assert.equal(body.length, MAX_COMMENT_LENGTH);
    assert.equal(body.slice(0, -TRUNCATED_NOTE.length), summary.slice(0, cut));
  });
});

describe('ai-review-summary.ts を直に走らせる', () => {
  const script = fileURLToPath(new URL('./ai-review-summary.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  test('まとめのファイルがあれば、その中身を本文に書く', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-summary-'));
    writeFileSync(join(dir, 'summary.md'), '## まとめ\n指摘なし\n');
    const result = run(join(dir, 'summary.md'), join(dir, 'body.md'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dir, 'body.md'), 'utf8'), '## まとめ\n指摘なし\n');
  });

  test('まとめのファイルが無ければ、書かずに終わった旨を本文に書く', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-summary-'));
    const result = run(join(dir, 'summary.md'), join(dir, 'body.md'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dir, 'body.md'), 'utf8'), MISSING_SUMMARY);
  });

  test('引数が足りなければ、1 で終わる', () => {
    assert.equal(run().status, 1);
  });
});
