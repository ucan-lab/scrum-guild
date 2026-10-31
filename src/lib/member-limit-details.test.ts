import { describe, expect, test } from 'vitest';
import { memberLimitDetailsOf } from './member-limit-details.ts';

describe('memberLimitDetailsOf', () => {
  test('used、limit、adding が非負の整数なら、その3つを返す', () => {
    expect(memberLimitDetailsOf({ used: 3, limit: 3, adding: 1, extra: 'x' })).toEqual({
      used: 3,
      limit: 3,
      adding: 1,
    });
    expect(memberLimitDetailsOf({ used: 0, limit: 1, adding: 0 })).toEqual({ used: 0, limit: 1, adding: 0 });
  });

  test('details が無い、null、文字列、配列、欠けた項目、数でない値、負数、小数のときは undefined', () => {
    for (const details of [
      undefined,
      null,
      'x',
      42,
      [],
      {},
      { used: 3, limit: 3 },
      { used: '3', limit: 3, adding: 1 },
      { used: 3, limit: 3, adding: -1 },
      { used: 3, limit: 3.5, adding: 1 },
      { used: Number.NaN, limit: 3, adding: 1 },
    ]) {
      expect(memberLimitDetailsOf(details), JSON.stringify(details)).toBeUndefined();
    }
  });
});
