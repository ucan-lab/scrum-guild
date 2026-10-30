import { describe, expect, test } from 'vitest';
import { startOfDayIn, todayIn, weekRangeIn } from './clock.ts';
import { addDays } from './due.ts';

describe('addDays', () => {
  test('月と年の境目、うるう日をまたいで足し引きする', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-25', 0)).toBe('2026-10-25');
  });

  test('暦に存在しない日付と整数でない日数は断る', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-10-25', 0.5)).toThrow(RangeError);
  });
});

describe('startOfDayIn（タイムゾーンでその日が始まる最初の時刻）', () => {
  test('時差が固定のタイムゾーン', () => {
    expect(startOfDayIn('Asia/Tokyo', '2026-11-02').toISOString()).toBe('2026-11-01T15:00:00.000Z');
    expect(startOfDayIn('UTC', '2026-11-02').toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(startOfDayIn('Pacific/Kiritimati', '2026-11-02').toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(startOfDayIn('Pacific/Pago_Pago', '2026-11-02').toISOString()).toBe('2026-11-02T11:00:00.000Z');
  });

  test('夏時間の切り替えの日をまたぐと、その日の時差で数える', () => {
    // 2026-11-01 の 2 時に夏時間が終わる（PDT −7 → PST −8）。11-01 の 0 時はまだ PDT、11-02 の 0 時は PST
    expect(startOfDayIn('America/Los_Angeles', '2026-11-01').toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(startOfDayIn('America/Los_Angeles', '2026-11-02').toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  test('どのタイムゾーンでも、返す時刻が初めてその日になる時刻（0 時が無い日を含む）', () => {
    const zones = [
      'UTC',
      'Asia/Tokyo',
      'Asia/Kolkata',
      'Asia/Kathmandu',
      'Australia/Lord_Howe',
      'Europe/London',
      'America/New_York',
      'America/Havana',
      'America/Santiago',
      'Pacific/Apia',
      'Pacific/Kiritimati',
      'Pacific/Pago_Pago',
    ];
    const dates = ['2026-01-01', '2026-03-08', '2026-03-29', '2026-04-05', '2026-09-06', '2026-10-25', '2026-11-01'];
    for (const zone of zones) {
      for (const date of dates) {
        const start = startOfDayIn(zone, date);
        expect(todayIn(zone, start), `${zone} ${date}`).toBe(date);
        expect(todayIn(zone, new Date(start.getTime() - 1)), `${zone} ${date} の1ミリ秒前`).not.toBe(date);
      }
    }
  });
});

describe('weekRangeIn（時刻を含む週の範囲）', () => {
  test('月曜始まりと日曜始まりで、日曜の昼の週が変わる', () => {
    const sunday = new Date('2026-11-01T10:00:00+09:00');
    // 月曜始まり: 10-26（月）〜11-01（日）。UTC では前の日の 15 時が境目
    expect(weekRangeIn('Asia/Tokyo', 1, sunday)).toEqual({
      start: '2026-10-25T15:00:00.000Z',
      end: '2026-11-01T15:00:00.000Z',
    });
    // 日曜始まり: 11-01（日）〜11-07（土）
    expect(weekRangeIn('Asia/Tokyo', 0, sunday)).toEqual({
      start: '2026-10-31T15:00:00.000Z',
      end: '2026-11-07T15:00:00.000Z',
    });
  });

  test('始まりの時刻ちょうどは新しい週に入り、1ミリ秒前は前の週に入る', () => {
    const startOfWeek = new Date('2026-11-01T15:00:00.000Z');
    expect(weekRangeIn('Asia/Tokyo', 1, startOfWeek).start).toBe('2026-11-01T15:00:00.000Z');
    expect(weekRangeIn('Asia/Tokyo', 1, new Date(startOfWeek.getTime() - 1)).end).toBe('2026-11-01T15:00:00.000Z');
  });

  test('夏時間をまたぐ週は、7日より1時間長くなる', () => {
    const range = weekRangeIn('America/Los_Angeles', 1, new Date('2026-10-28T12:00:00Z'));
    expect(range).toEqual({ start: '2026-10-26T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z' });
  });
});
