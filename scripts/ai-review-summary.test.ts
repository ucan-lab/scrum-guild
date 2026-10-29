import assert from 'node:assert/strict';
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
});
