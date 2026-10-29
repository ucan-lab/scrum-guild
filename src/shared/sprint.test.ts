import { describe, expect, test } from 'vitest';
import { SPRINT_GOAL_MAX_LENGTH, sprintGoalProblem, sprintGoalSchema } from './sprint.ts';

describe('スプリントのゴールの長さ', () => {
  test('上限は 200 字', () => {
    expect(SPRINT_GOAL_MAX_LENGTH).toBe(200);
  });

  test.each([
    [199, null],
    [200, null],
    [201, 'too_long'],
  ])('%i 字は %s', (length, expected) => {
    expect(sprintGoalProblem('あ'.repeat(length))).toBe(expected);
  });

  test('コードポイントで数える（絵文字 200 個は通り、201 個は断る）', () => {
    expect(sprintGoalProblem('🎉'.repeat(200))).toBeNull();
    expect(sprintGoalProblem('🎉'.repeat(201))).toBe('too_long');
  });

  test('ゴールなし（null）は誤りではない', () => {
    expect(sprintGoalProblem(null)).toBeNull();
  });

  test('結合した絵文字もコードポイントで数える（家族の絵文字は 5 字）', () => {
    expect(sprintGoalProblem('👨‍👩‍👧'.repeat(40))).toBeNull();
    expect(sprintGoalProblem('👨‍👩‍👧'.repeat(41))).toBe('too_long');
  });
});

describe('スプリントのゴールのスキーマ（正規化の後で数える）', () => {
  const parse = (raw: string) => sprintGoalSchema.safeParse(raw);

  test('前後の空白と改行を除いて 200 字なら通り、除いた値になる', () => {
    const result = parse(' ' + 'あ'.repeat(200) + '\n');
    expect(result.success).toBe(true);
    expect(result.data).toBe('あ'.repeat(200));
  });

  test('前後の空白を除いて 201 字なら断る', () => {
    expect(parse(' ' + 'あ'.repeat(201) + '\n').success).toBe(false);
  });

  test('CRLF は LF にそろえて 1 字と数える', () => {
    expect(parse('あ\r\n'.repeat(99) + 'あ').success).toBe(true); // 199 字
    expect(parse('あ\r\n'.repeat(100) + 'あ').success).toBe(false); // 201 字
  });
});
