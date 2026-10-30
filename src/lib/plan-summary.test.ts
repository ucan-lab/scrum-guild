import { describe, expect, test } from 'vitest';
import {
  epicRemaining,
  formatPoints,
  isOverVelocity,
  laneFillShape,
  overBy,
  velocityBarShape,
} from './plan-summary.ts';

describe('formatPoints', () => {
  test('整数はそのまま、小数は 1 桁', () => {
    expect(formatPoints(8)).toBe('8');
    expect(formatPoints(0)).toBe('0');
    expect(formatPoints(21.3333)).toBe('21.3');
    expect(formatPoints(7.5)).toBe('7.5');
  });
});

describe('isOverVelocity と overBy', () => {
  test('ベロシティを上回るときだけ真で、同じ値と下回りは偽。ベロシティが出ていないときは比べない', () => {
    expect(isOverVelocity(22, 21.3)).toBe(true);
    expect(isOverVelocity(21, 21.3)).toBe(false);
    expect(isOverVelocity(8, 8)).toBe(false);
    expect(isOverVelocity(99, null)).toBe(false);
    expect(overBy(22, 20)).toBe(2);
    expect(overBy(20, 20)).toBe(0);
    expect(overBy(10, 20)).toBe(0);
    expect(overBy(10, null)).toBe(0);
  });
});

describe('laneFillShape', () => {
  test('大きい方の 1.15 倍を棒の長さにして、幅と印の位置を % で返す', () => {
    const over = laneFillShape(23, 20);
    expect(over.width).toBeCloseTo(100 / 1.15);
    expect(over.mark).toBeCloseTo((20 / (23 * 1.15)) * 100);
    const under = laneFillShape(10, 20);
    expect(under.width).toBeCloseTo((10 / 23) * 100);
    expect(under.mark).toBeCloseTo(100 / 1.15);
  });

  test('ベロシティが無ければ印は null。どちらも 0 なら 0 で割らない', () => {
    expect(laneFillShape(5, null).mark).toBeNull();
    expect(laneFillShape(0, 0)).toEqual({ width: 0, mark: 0 });
    expect(laneFillShape(0, null)).toEqual({ width: 0, mark: null });
  });
});

describe('velocityBarShape', () => {
  test('いちばん大きい値が棒グラフの高さになり、平均の線は同じ尺度で引く', () => {
    expect(velocityBarShape([10, 40, 20], 23.3, 90)).toEqual({
      heights: [22.5, 90, 45],
      mark: (23.3 / 40) * 90,
    });
  });

  test('全部 0 でも 0 で割らず、平均が無ければ線は null', () => {
    expect(velocityBarShape([0, 0], 0, 90)).toEqual({ heights: [0, 0], mark: 0 });
    expect(velocityBarShape([], null, 90)).toEqual({ heights: [], mark: null });
  });
});

describe('epicRemaining', () => {
  test('全体から完了した分を引く', () => {
    expect(epicRemaining({ points_done: 5, points_all: 10 })).toBe(5);
    expect(epicRemaining({ points_done: 2, points_all: 2 })).toBe(0);
    expect(epicRemaining({ points_done: 0, points_all: 0 })).toBe(0);
  });
});
