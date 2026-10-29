import { describe, expect, test } from 'vitest';
import { SPRINT_GOAL_MAX_LENGTH, sprintGoalProblem } from './sprint.ts';

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
});
