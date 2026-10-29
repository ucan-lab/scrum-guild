// パスワードのそろえ方（src/shared/password.ts、Issue #256）。NFC にそろえ、そろえた後のコードポイントの数で12〜128文字
import { describe, expect, test } from 'vitest';
import { normalizePassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.ts';

// 合成済みの「が」（U+304C）と、分解した「か」＋濁点（U+304B U+3099）
const COMPOSED_GA = 'が';
const DECOMPOSED_GA = 'が';
// サロゲートペアで書く1文字（UTF-16 では2単位）
const EMOJI = '\u{1F600}';
// NFC にそろえると2つのコードポイントに分かれる文字（U+0344 → U+0308 U+0301）
const EXPANDS_UNDER_NFC = '̈́';

describe('長さの境目', () => {
  test('決まった長さは12〜128', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  test.each([
    [12, true],
    [13, true],
    [127, true],
    [128, true],
    [11, false],
    [129, false],
    [0, false],
  ])('ASCII の %i 文字を受けるか: %s', (length, accepted) => {
    const input = 'p'.repeat(length);
    expect(normalizePassword(input)).toBe(accepted ? input : undefined);
  });

  test('サロゲートペアの文字は1文字と数える（12文字は受け、UTF-16 の長さの24では数えない）', () => {
    expect(normalizePassword(EMOJI.repeat(12))).toBe(EMOJI.repeat(12));
    expect(normalizePassword(EMOJI.repeat(128))).toBe(EMOJI.repeat(128));
  });

  test('サロゲートペアの11文字は、UTF-16 で22単位あっても短すぎる', () => {
    expect(normalizePassword(EMOJI.repeat(11))).toBeUndefined();
  });

  test('サロゲートペアの129文字は長すぎる', () => {
    expect(normalizePassword(EMOJI.repeat(129))).toBeUndefined();
  });
});

describe('NFC', () => {
  test('分解した「が」は合成済みにそろえ、合成済みと同じ値を返す', () => {
    const composed = `${COMPOSED_GA.repeat(6)}secret`;
    const decomposed = `${DECOMPOSED_GA.repeat(6)}secret`;
    expect(normalizePassword(decomposed)).toBe(composed);
    expect(normalizePassword(composed)).toBe(composed);
  });

  test('長さはそろえた後で数える: 分解した12文字（24コードポイント）は受ける', () => {
    expect(normalizePassword(DECOMPOSED_GA.repeat(12))).toBe(COMPOSED_GA.repeat(12));
  });

  test('長さはそろえた後で数える: 分解した65文字（130コードポイント）は、そろえて65文字なので受ける', () => {
    expect(normalizePassword(DECOMPOSED_GA.repeat(65))).toBe(COMPOSED_GA.repeat(65));
  });

  test('長さはそろえた後で数える: 分解した11文字（22コードポイント）は、そろえて11文字なので短すぎる', () => {
    expect(normalizePassword(DECOMPOSED_GA.repeat(11))).toBeUndefined();
  });

  test('そろえると長くなる文字: 入力の11文字がそろえて12文字なら受ける', () => {
    const input = `${'a'.repeat(10)}${EXPANDS_UNDER_NFC}`;
    expect([...input]).toHaveLength(11);
    expect(normalizePassword(input)).toBe(input.normalize('NFC'));
  });

  test('そろえると長くなる文字: 入力の128文字がそろえて129文字なら長すぎる', () => {
    const input = `${'a'.repeat(127)}${EXPANDS_UNDER_NFC}`;
    expect([...input]).toHaveLength(128);
    expect(normalizePassword(input)).toBeUndefined();
  });
});
