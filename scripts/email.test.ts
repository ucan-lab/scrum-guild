import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CLAIM_TOKEN_PATTERN } from '../src/shared/claim-token.ts';
import { EMAIL_MAX_LENGTH, normalizeEmail } from '../src/shared/email.ts';

describe('メールアドレスをそろえる関数', () => {
  test('ASCII の英大文字だけを小文字に直す', () => {
    assert.equal(normalizeEmail('Mio.Hoshino@Example.COM'), 'mio.hoshino@example.com');
    assert.equal(normalizeEmail('MIO@EXAMPLE.COM'), 'mio@example.com');
  });

  test('前後の空白を除く（途中は残さず、断る）', () => {
    assert.equal(normalizeEmail('  mio@example.com  '), 'mio@example.com');
    assert.equal(normalizeEmail('\t\nmio@example.com\r\n'), 'mio@example.com');
    assert.equal(normalizeEmail('mio @example.com'), undefined);
    assert.equal(normalizeEmail('mio@exa mple.com'), undefined);
  });

  test('ASCII の外の文字を含むものは受け付けない（全角の空白、NBSP、日本語、全角の英字を含む）', () => {
    for (const value of [
      'mio@example.com ',
      '　mio@example.com',
      ' mio@example.com',
      'みお@example.com',
      'mio@例え.jp',
      'ｍｉｏ@example.com',
      // 大文字の İ（U+0130）は toLowerCase で ASCII の i に近づくが、ASCII の外なので断る
      'İo@example.com',
      'mio@example.com​',
    ]) {
      assert.equal(normalizeEmail(value), undefined, JSON.stringify(value));
    }
  });

  test('ドットと + 以降は読み替えない', () => {
    assert.equal(normalizeEmail('mio.hoshino@gmail.com'), 'mio.hoshino@gmail.com');
    assert.notEqual(normalizeEmail('mio.hoshino@gmail.com'), normalizeEmail('miohoshino@gmail.com'));
    assert.equal(normalizeEmail('Mio+Guild@example.com'), 'mio+guild@example.com');
    assert.notEqual(normalizeEmail('mio+guild@example.com'), normalizeEmail('mio@example.com'));
  });

  test('入力と ID トークンの email が、大文字小文字と前後の空白だけ違うなら同じ値になる', () => {
    assert.equal(normalizeEmail(' Mio.Hoshino@Example.com '), normalizeEmail('mio.hoshino@example.com'));
  });

  test('@ が1つで前後に文字があるものだけ', () => {
    for (const value of ['', '   ', 'mio', '@example.com', 'mio@', 'mio@@example.com', 'a@b@c.example']) {
      assert.equal(normalizeEmail(value), undefined, JSON.stringify(value));
    }
    assert.equal(normalizeEmail('a@b'), 'a@b');
  });

  test('制御文字を含むものは受け付けない', () => {
    for (const value of ['mio\u0000@example.com', 'mio\u007f@example.com', 'mio\u0001@example.com']) {
      assert.equal(normalizeEmail(value), undefined, JSON.stringify(value));
    }
  });

  test('254文字まで', () => {
    const domain = '@example.com';
    assert.ok(normalizeEmail(`${'a'.repeat(EMAIL_MAX_LENGTH - domain.length)}${domain}`) !== undefined);
    assert.equal(normalizeEmail(`${'a'.repeat(EMAIL_MAX_LENGTH - domain.length + 1)}${domain}`), undefined);
  });

  test('結果は DB の CHECK（lower(trim(x)) と同じ）を通る形', () => {
    for (const value of ['Mio@Example.com', ' mio@example.com ']) {
      const normalized = normalizeEmail(value);
      assert.ok(normalized !== undefined);
      assert.equal(normalized, normalized.toLowerCase().trim());
    }
  });
});

describe('招待の URL の秘密の形', () => {
  test('base64url の43文字だけ', () => {
    assert.ok(CLAIM_TOKEN_PATTERN.test('A'.repeat(43)));
    assert.ok(CLAIM_TOKEN_PATTERN.test('Qm7tX2vLr9aKpE4wZc8hN3bYd6fGs1uJ0oTiRl5eWxA'));
    for (const value of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}\n`,
    ]) {
      assert.ok(!CLAIM_TOKEN_PATTERN.test(value), JSON.stringify(value));
    }
  });
});
