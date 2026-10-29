import { sprintExtension } from './sprint.ts';
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

describe('sprintExtension', () => {
  const active = { end_on: '2026-11-01' };
  const planned = (id: string, start_on: string, end_on: string) => ({
    id,
    name: id,
    start_on,
    end_on,
    status: 'planned',
  });
  test('重ならなければ動かさない', () => {
    expect(sprintExtension(active, 3, [planned('a', '2026-11-05', '2026-11-10')])).toEqual({
      end_on: '2026-11-04',
      shifted: [],
    });
  });
  test('間の空きで一部を吸収する', () => {
    expect(sprintExtension(active, 3, [planned('a', '2026-11-03', '2026-11-08')])?.shifted).toEqual([
      { id: 'a', name: 'a', start_on: '2026-11-05', end_on: '2026-11-10', days: 2 },
    ]);
  });
  test('開始日順に押し出しが続く', () => {
    expect(
      sprintExtension(active, 3, [
        planned('b', '2026-11-09', '2026-11-15'),
        planned('a', '2026-11-02', '2026-11-08'),
      ])?.shifted.map((s) => [s.id, s.start_on, s.end_on, s.days]),
    ).toEqual([
      ['a', '2026-11-05', '2026-11-11', 3],
      ['b', '2026-11-12', '2026-11-18', 3],
    ]);
  });
  test('途中の空きで止まり、削除済みと planned 以外を動かさない', () => {
    const rows = [
      planned('a', '2026-11-02', '2026-11-08'),
      planned('b', '2026-11-12', '2026-11-18'),
      { ...planned('deleted', '2026-11-02', '2026-11-08'), deleted_at: '2026-10-01' },
      { ...planned('closed', '2026-11-02', '2026-11-08'), status: 'closed' },
    ];
    expect(sprintExtension(active, 3, rows)?.shifted.map((s) => s.id)).toEqual(['a']);
    expect(rows[0]?.start_on).toBe('2026-11-02');
  });
});
