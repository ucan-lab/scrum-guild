import { describe, expect, test } from 'vitest';
import { levelOf, levelProgressOf, levelStartOf } from './experience.ts';

describe('レベル', () => {
  test('レベル L に達する合計は 50 × L × (L − 1)', () => {
    expect([1, 2, 3, 5, 10, 20].map(levelStartOf)).toEqual([0, 100, 300, 1000, 4500, 19000]);
  });

  test.each([
    [0, 1],
    [99, 1],
    [100, 2],
    [299, 2],
    [300, 3],
    [999, 4],
    [1000, 5],
    [4499, 9],
    [4500, 10],
    [19000, 20],
    [1_000_000_000, 4472],
  ])('合計 %i はレベル %i', (total, level) => {
    expect(levelOf(total)).toBe(level);
  });

  test('合計が 0 を下回ってもレベル1。数でない値もレベル1', () => {
    expect(levelOf(-1)).toBe(1);
    expect(levelOf(-500)).toBe(1);
    expect(levelOf(Number.NaN)).toBe(1);
  });

  test('境界の前後で、どの合計も始まりの合計以上、次の始まり未満に入る', () => {
    for (let total = -10; total <= 20000; total++) {
      const level = levelOf(total);
      if (total >= 0) {
        expect(levelStartOf(level)).toBeLessThanOrEqual(total);
        expect(levelStartOf(level + 1)).toBeGreaterThan(total);
      }
    }
  });
});

describe('ゲージの割合', () => {
  test('確定は今のレベルの幅（100 × L）のうち貯まった分', () => {
    expect(levelProgressOf(0)).toEqual({
      level: 1,
      levelStart: 0,
      nextLevelAt: 100,
      toNext: 100,
      confirmedRatio: 0,
      prospectiveRatio: 0,
    });
    expect(levelProgressOf(99).confirmedRatio).toBeCloseTo(0.99);
    expect(levelProgressOf(100)).toMatchObject({ level: 2, levelStart: 100, nextLevelAt: 300, confirmedRatio: 0 });
    expect(levelProgressOf(299)).toMatchObject({ level: 2, toNext: 1, confirmedRatio: 0.995 });
    expect(levelProgressOf(300)).toMatchObject({ level: 3, levelStart: 300, nextLevelAt: 600, confirmedRatio: 0 });
    expect(levelProgressOf(4500)).toMatchObject({ level: 10, levelStart: 4500, nextLevelAt: 5500, toNext: 1000 });
  });

  test('見込みは確定の残りの幅を超えない', () => {
    // レベル7（2100〜2800）の 2550 は 64% を確定。見込み 140 は 20%
    const progress = levelProgressOf(2550, 140);
    expect(progress.confirmedRatio).toBeCloseTo(0.6428, 3);
    expect(progress.prospectiveRatio).toBeCloseTo(0.2);
    expect(levelProgressOf(90, 50)).toMatchObject({ confirmedRatio: 0.9 });
    expect(levelProgressOf(90, 50).prospectiveRatio).toBeCloseTo(0.1);
    expect(levelProgressOf(0, -10).prospectiveRatio).toBe(0);
  });

  test('合計が負なら、確定は 0 で、次のレベルまでの残りは 0 までの分も含む', () => {
    expect(levelProgressOf(-30, 20)).toEqual({
      level: 1,
      levelStart: 0,
      nextLevelAt: 100,
      toNext: 130,
      confirmedRatio: 0,
      prospectiveRatio: 0.2,
    });
  });
});
