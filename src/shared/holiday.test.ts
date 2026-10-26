import { describe, expect, test } from 'vitest';
import {
  HOLIDAY_NAME_MAX_LENGTH,
  holidayNameSchema,
  holidayOnSchema,
  normalizeHolidayName,
  parseHolidayPaste,
} from './holiday.ts';

describe('parseHolidayPaste（貼り付けた休日の一覧を行ごとに読む）', () => {
  test('1行に1日。日付の後に名前を書け、空の行は飛ばす', () => {
    expect(parseHolidayPaste('2026-11-03 文化の日\n\n  \n2026-11-23 勤労感謝の日\n')).toEqual({
      holidays: [
        { holiday_on: '2026-11-03', name: '文化の日' },
        { holiday_on: '2026-11-23', name: '勤労感謝の日' },
      ],
      problems: [],
    });
  });

  test.each([
    ['半角の空白', '2026-11-03 文化の日'],
    ['続く空白', '2026-11-03    文化の日'],
    ['全角の空白', '2026-11-03\u{3000}文化の日'],
    ['タブ', '2026-11-03\t文化の日'],
    ['カンマ', '2026-11-03,文化の日'],
    ['前後に空白のあるカンマ', '2026-11-03 , 文化の日'],
  ])('日付と名前の区切りは%s', (_, line) => {
    expect(parseHolidayPaste(line).holidays).toEqual([{ holiday_on: '2026-11-03', name: '文化の日' }]);
  });

  test('YYYY/M/D（内閣府の祝日の CSV の形）を YYYY-MM-DD にそろえる。改行は CRLF でも読む', () => {
    expect(parseHolidayPaste('2027/1/1,元日\r\n2027/2/11,建国記念の日\r\n').holidays).toEqual([
      { holiday_on: '2027-01-01', name: '元日' },
      { holiday_on: '2027-02-11', name: '建国記念の日' },
    ]);
  });

  test('名前は無くてよい（null）。名前の前後の空白は除き、名前の中の空白とカンマは残す', () => {
    expect(parseHolidayPaste('2026-12-29\n2026-12-30 ,\n2026-12-31  年末 休み, 全社 ').holidays).toEqual([
      { holiday_on: '2026-12-29', name: null },
      { holiday_on: '2026-12-30', name: null },
      { holiday_on: '2026-12-31', name: '年末 休み, 全社' },
    ]);
  });

  test('形の合わない行は、行の番号（1から）と理由を返し、正しい行だけを使う', () => {
    const text = [
      '2026-11-03 文化の日',
      '国民の祝日・休日月日,国民の祝日・休日名称',
      '2026-1-3 三が日',
      '2026/11/23/1 勤労感謝の日',
      '2026-02-30 無い日',
      '2027/2/29',
      `2026-11-04 ${'あ'.repeat(HOLIDAY_NAME_MAX_LENGTH + 1)}`,
      '2026-11-05 見えない\u{200B}文字',
      '2026/11/3 文化の日（2回目）',
      '',
      '2026-11-06 開発合宿',
    ].join('\n');
    const result = parseHolidayPaste(text);
    expect(result.holidays).toEqual([
      { holiday_on: '2026-11-03', name: '文化の日' },
      { holiday_on: '2026-11-06', name: '開発合宿' },
    ]);
    expect(result.problems.map(({ line, reason }) => ({ line, reason }))).toEqual([
      { line: 2, reason: 'invalid_date' },
      { line: 3, reason: 'invalid_date' },
      { line: 4, reason: 'invalid_date' },
      { line: 5, reason: 'no_such_date' },
      { line: 6, reason: 'no_such_date' },
      { line: 7, reason: 'too_long' },
      { line: 8, reason: 'invalid_character' },
      { line: 9, reason: 'duplicate' },
    ]);
    // 行は前後の空白を除いたまま返す（画面が行を添えて理由を出す）
    expect(result.problems[0]?.text).toBe('国民の祝日・休日月日,国民の祝日・休日名称');
  });

  test.each([
    ['1999-12-31', 'out_of_range'],
    ['2100-01-01', 'out_of_range'],
    ['1926/11/3', 'out_of_range'],
  ])('%s は登録できる年（2000〜2099）の外', (date, reason) => {
    expect(parseHolidayPaste(`${date} 祝日`).problems.map((problem) => problem.reason)).toEqual([reason]);
  });

  test('2000-01-01 と 2099-12-31 は通る', () => {
    expect(parseHolidayPaste('2000-01-01 元日\n2099-12-31').holidays).toEqual([
      { holiday_on: '2000-01-01', name: '元日' },
      { holiday_on: '2099-12-31', name: null },
    ]);
  });

  test('タブで区切った表計算の行は、名前の後の列を捨て、名前の列が空なら名前なしにする', () => {
    expect(parseHolidayPaste('2026-11-03\t文化の日\t祝日\t備考\n2026-11-23\t\t勤労感謝の日\t祝日').holidays).toEqual([
      { holiday_on: '2026-11-03', name: '文化の日' },
      { holiday_on: '2026-11-23', name: null },
    ]);
  });

  test('CSV の名前の前後の二重引用符を1組だけ外す', () => {
    expect(parseHolidayPaste('2027/1/1,"元日"\n2027/1/11,""成人の日""\n2027/2/11,""').holidays).toEqual([
      { holiday_on: '2027-01-01', name: '元日' },
      { holiday_on: '2027-01-11', name: '"成人の日"' },
      { holiday_on: '2027-02-11', name: null },
    ]);
  });

  test('名前はちょうど上限の字数まで通る。字数はコードポイントで数える', () => {
    const name = '🎌'.repeat(HOLIDAY_NAME_MAX_LENGTH);
    expect(parseHolidayPaste(`2026-11-03 ${name}`).holidays).toEqual([{ holiday_on: '2026-11-03', name }]);
  });

  test('正しい行が上限を超えても切らない（画面が分けて送るよう示す）', () => {
    const lines = Array.from({ length: 101 }, (_, i) => {
      const at = new Date(Date.UTC(2030, 0, 1 + i));
      return at.toISOString().slice(0, 10);
    });
    expect(parseHolidayPaste(lines.join('\n')).holidays).toHaveLength(101);
  });

  test('空の貼り付けは、日も理由も無い', () => {
    expect(parseHolidayPaste('')).toEqual({ holidays: [], problems: [] });
    expect(parseHolidayPaste('\n \u{3000}\n')).toEqual({ holidays: [], problems: [] });
  });
});

describe('normalizeHolidayName', () => {
  test('空白と見えない文字だけなら null', () => {
    expect(normalizeHolidayName('')).toBeNull();
    expect(normalizeHolidayName(' \u{3000} ')).toBeNull();
    expect(normalizeHolidayName('\u{200B}')).toBeNull();
    expect(normalizeHolidayName(' 創立記念日 ')).toBe('創立記念日');
  });
});

describe('API の検証のスキーマ', () => {
  test('日付は YYYY-MM-DD の暦の日付だけ', () => {
    expect(holidayOnSchema.safeParse('2026-11-03').success).toBe(true);
    expect(holidayOnSchema.safeParse('2000-01-01').success).toBe(true);
    expect(holidayOnSchema.safeParse('2099-12-31').success).toBe(true);
    for (const value of ['2026/11/3', '2026-02-30', '2026-11-3', '', '1999-12-31', '2100-01-01']) {
      expect(holidayOnSchema.safeParse(value).success, value).toBe(false);
    }
  });

  test('名前は前後の空白を除き、空は null。長すぎるものと見えない文字を含むものは断る', () => {
    expect(holidayNameSchema.parse(' 創立記念日 ')).toBe('創立記念日');
    expect(holidayNameSchema.parse('  ')).toBeNull();
    expect(holidayNameSchema.parse(null)).toBeNull();
    expect(holidayNameSchema.safeParse('あ'.repeat(HOLIDAY_NAME_MAX_LENGTH + 1)).success).toBe(false);
    expect(holidayNameSchema.safeParse('見えない\u{202E}文字').success).toBe(false);
  });
});
