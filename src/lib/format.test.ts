import { describe, expect, test } from 'vitest';
import { formatUtcDate } from './format.ts';

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
