import { describe, expect, test } from 'vitest';
import { parseHolidayPaste } from '../shared/holiday.ts';
import {
  PROBLEM_TEXT_MAX_LENGTH,
  VISIBLE_PROBLEM_LINES,
  problemLineText,
  remainingPasteText,
  visibleProblems,
} from './holiday-paste.ts';

describe('remainingPasteText（送れた後に欄へ残す文）', () => {
  test('直せば登録できる行だけを残し、同じ日付が前の行にあった行は落とす', () => {
    const { problems } = parseHolidayPaste(
      ['2027-02-11 建国記念の日', '2027-02-30 無い日', '2027/2/11 重なり', '1999-01-01 古い日'].join('\n'),
    );
    expect(remainingPasteText(problems)).toBe('2027-02-30 無い日\n1999-01-01 古い日');
  });

  test('送った時点の解析の結果から作る。後から欄が変わっても、送った内容の行だけを残す', () => {
    const atSubmit = parseHolidayPaste('2027-02-11 建国記念の日\n2027-02-30 無い日');
    // 送っている間に打ち足された行は、送った時点の結果に入らない
    parseHolidayPaste('2027-02-11 建国記念の日\n2027-02-30 無い日\n2027-13-01 打ち足した行');
    expect(remainingPasteText(atSubmit.problems)).toBe('2027-02-30 無い日');
  });

  test('理由が無ければ空', () => {
    expect(remainingPasteText([])).toBe('');
  });
});

describe('problemLineText（理由に添える行の文字）', () => {
  test(`${PROBLEM_TEXT_MAX_LENGTH} 字までは、そのまま`, () => {
    const text = 'あ'.repeat(PROBLEM_TEXT_MAX_LENGTH);
    expect(problemLineText(text)).toBe(text);
  });

  test('超えたら切って「…」を付ける。字数はコードポイントで数える', () => {
    expect(problemLineText('🎌'.repeat(PROBLEM_TEXT_MAX_LENGTH + 5))).toBe(`${'🎌'.repeat(PROBLEM_TEXT_MAX_LENGTH)}…`);
  });
});

describe('visibleProblems（一覧に出す理由）', () => {
  test(`${VISIBLE_PROBLEM_LINES} 行まで出し、超えた分は数だけ返す`, () => {
    const { problems } = parseHolidayPaste(Array.from({ length: 13 }, (_, i) => `x${i}`).join('\n'));
    const result = visibleProblems(problems);
    expect(result.shown.map((problem) => problem.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.hidden).toBe(3);
  });

  test('少なければ全部出す', () => {
    const { problems } = parseHolidayPaste('x');
    expect(visibleProblems(problems)).toEqual({ shown: problems, hidden: 0 });
  });
});
