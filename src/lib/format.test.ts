import { describe, expect, test } from 'vitest';
import { formatCount, formatUtcDate, quotaSize } from './format.ts';

describe('quotaSize', () => {
  test('1 GB 以上は、1024³ バイトを 1 GB として、小数は1桁まで出す', () => {
    expect(quotaSize(32212254720)).toEqual({ size: '30', unit: 'gb' });
    expect(quotaSize(1024 ** 3 * 1.5)).toEqual({ size: '1.5', unit: 'gb' });
    expect(quotaSize(1024 ** 3 * 1.04)).toEqual({ size: '1', unit: 'gb' });
    expect(quotaSize(1024 ** 3)).toEqual({ size: '1', unit: 'gb' });
    expect(quotaSize(1024 ** 4)).toEqual({ size: '1,024', unit: 'gb' });
  });

  test('1 GB 未満は「0 GB」にせず、MB で出す', () => {
    expect(quotaSize(1024 ** 3 - 1)).toEqual({ size: '1,024', unit: 'mb' });
    expect(quotaSize(512 * 1024 ** 2)).toEqual({ size: '512', unit: 'mb' });
    expect(quotaSize(1024 ** 2 * 0.5)).toEqual({ size: '0.5', unit: 'mb' });
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
