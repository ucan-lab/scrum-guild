// ストーリーの欄の決まり（src/shared/story.ts）。Worker と画面の両方が使うので、Node でも確かめる
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  STORY_TEXT_MAX_LENGTH,
  canonicalLinkUrl,
  linkUrlProblem,
  linkUrlSchema,
  longTextProblem,
  longTextSchema,
  normalizeLinkUrl,
  normalizeLongText,
} from '../src/shared/story.ts';

describe('normalizeLongText', () => {
  test('改行をそろえ、末尾の空白と前後の空行を除き、空は null', () => {
    assert.equal(normalizeLongText('a\r\nb\rc  \n\n'), 'a\nb\nc');
    assert.equal(normalizeLongText(' \n\t '), null);
    assert.equal(normalizeLongText(''), null);
    assert.equal(normalizeLongText('\n \n\nはじめ\n'), 'はじめ');
  });

  test('先頭の行の字下げは残す（コードブロックや入れ子の箇条書きを壊さない）', () => {
    assert.equal(normalizeLongText('    const a = 1;\n    const b = 2;\n'), '    const a = 1;\n    const b = 2;');
    assert.equal(normalizeLongText('\n\n  - 入れ子\n- 親'), '  - 入れ子\n- 親');
    assert.equal(normalizeLongText('\t字下げ'), '\t字下げ');
  });

  test('空白の長い列の後に文字があっても、時間がかからない', () => {
    const value = `a${' '.repeat(1_000_000)}b`;
    const started = performance.now();
    assert.equal(normalizeLongText(value), value);
    assert.ok(performance.now() - started < 1000);
  });
});

describe('longTextProblem', () => {
  test('改行とタブは使え、それ以外の制御文字と見えない文字は断る', () => {
    assert.equal(longTextProblem('a\n\tb'), null);
    assert.equal(longTextProblem('a\u{0000}b'), 'invalid_character');
    assert.equal(longTextProblem('a\u{200B}b'), 'invalid_character');
    assert.equal(longTextProblem('a\u{202E}b'), 'invalid_character');
  });

  test('1万字まで。コードポイントで数える', () => {
    assert.equal(longTextProblem('あ'.repeat(STORY_TEXT_MAX_LENGTH)), null);
    assert.equal(longTextProblem('😀'.repeat(STORY_TEXT_MAX_LENGTH)), null);
    assert.equal(longTextProblem('あ'.repeat(STORY_TEXT_MAX_LENGTH + 1)), 'too_long');
  });

  test('スキーマは正規化した値を返し、空は null', () => {
    assert.equal(longTextSchema.parse('  x\r\n'), '  x');
    assert.equal(longTextSchema.parse('  \n'), null);
    assert.equal(longTextSchema.parse(null), null);
    assert.equal(longTextSchema.safeParse('a\u{0000}').success, false);
  });
});

describe('linkUrlProblem', () => {
  test('http と https の URL だけ', () => {
    assert.equal(linkUrlProblem('https://example.com/a?b=c#d'), null);
    assert.equal(linkUrlProblem('http://localhost:8787/x'), null);
    assert.equal(linkUrlProblem('HTTPS://example.com'), null);
    for (const ng of [
      'ftp://example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'http:/example.com',
      'https://',
      'example.com',
      'https://exa mple.com',
      'https://example.com/\u{200B}',
    ]) {
      assert.equal(linkUrlProblem(ng), 'invalid_url', ng);
    }
  });

  test('ユーザー名やパスワードを含む URL は断る', () => {
    for (const ng of ['https://user@example.com/', 'https://user:pass@example.com/', 'http://:pass@example.com/']) {
      assert.equal(linkUrlProblem(ng), 'invalid_url', ng);
    }
    // パスやクエリの中の @ は資格情報ではない
    assert.equal(linkUrlProblem('https://example.com/@user?mail=a@b'), null);
  });

  test('2048字まで', () => {
    const prefix = 'https://example.com/';
    assert.equal(linkUrlProblem(prefix + 'a'.repeat(2048 - prefix.length)), null);
    assert.equal(linkUrlProblem(prefix + 'a'.repeat(2049 - prefix.length)), 'too_long');
  });

  test('正規化した href が 2048 字を超えるものも断る（記号の符号化で伸びる）', () => {
    const prefix = 'https://example.com/';
    assert.equal(linkUrlProblem(prefix + 'あ'.repeat(700)), 'too_long');
  });

  test('前後の空白を除き、空は null', () => {
    assert.equal(normalizeLinkUrl('  https://example.com  '), 'https://example.com');
    assert.equal(normalizeLinkUrl('   '), null);
  });
});

describe('linkUrlSchema', () => {
  test('保存する値は URL を解釈した href にそろえる', () => {
    assert.equal(linkUrlSchema.parse('HTTPS://Example.COM'), 'https://example.com/');
    assert.equal(linkUrlSchema.parse('  https://example.com/a?b=c#d  '), 'https://example.com/a?b=c#d');
  });

  test('空は null、使えない値は検証で落とす', () => {
    assert.equal(linkUrlSchema.parse('  '), null);
    assert.equal(linkUrlSchema.parse(null), null);
    for (const ng of ['ftp://example.com', 'https://user:pw@example.com/', 'http:/example.com']) {
      assert.equal(linkUrlSchema.safeParse(ng).success, false, ng);
    }
  });

  test('canonicalLinkUrl は href を返す', () => {
    assert.equal(canonicalLinkUrl('https://example.com'), 'https://example.com/');
    assert.equal(canonicalLinkUrl('https://example.com/あ'), 'https://example.com/%E3%81%82');
  });
});
