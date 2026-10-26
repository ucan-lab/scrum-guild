import { describe, expect, test } from 'vitest';
import { formatCount, formatGigabytes, formatUtcDate } from './format.ts';

describe('formatGigabytes', () => {
  test('1024³ バイトを 1 GB として、小数は1桁まで出す', () => {
    expect(formatGigabytes(32212254720)).toBe('30');
    expect(formatGigabytes(1024 ** 3 * 1.5)).toBe('1.5');
    expect(formatGigabytes(1024 ** 3 * 1.04)).toBe('1');
    expect(formatGigabytes(1024 ** 4)).toBe('1,024');
    expect(formatGigabytes(0)).toBe('0');
  });
});

describe('formatCount', () => {
  test('3桁ごとに区切る', () => {
    expect(formatCount(1284)).toBe('1,284');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatUtcDate', () => {
  test('UTC の日付にする。ブラウザのタイムゾーンで日付が変わる時刻でも、UTC の日付のまま', () => {
    expect(formatUtcDate('2026-10-26T00:00:00.000Z')).toBe('2026-10-26');
    expect(formatUtcDate('2026-10-26T23:59:59.999Z')).toBe('2026-10-26');
    expect(formatUtcDate('2026-10-26T20:00:00+09:00')).toBe('2026-10-26');
    expect(formatUtcDate('2026-10-27T01:00:00+09:00')).toBe('2026-10-26');
  });

  test('読めない値は元のまま返す', () => {
    expect(formatUtcDate('not a date')).toBe('not a date');
  });
});
