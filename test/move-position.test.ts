// 移す行の新しい位置の決め方（src/server/operations/move-position.ts）。DB を使わない
import { describe, expect, test } from 'vitest';
import { MAX_TIES, placeAfter, placeFirst, placeLast } from '../src/server/operations/move-position.ts';

const row = (id: string, position: string) => ({ id, position });

describe('placeFirst と placeLast', () => {
  test('空の並びでは a0、行があれば最初の前か最後の後', () => {
    expect(placeFirst(undefined)).toEqual({ position: 'a0', renumber: [] });
    expect(placeLast(undefined)).toEqual({ position: 'a0', renumber: [] });
    expect(placeFirst(row('x', 'a0')).position < 'a0').toBe(true);
    expect(placeLast(row('x', 'a5')).position > 'a5').toBe(true);
  });
});

describe('placeAfter', () => {
  test('同じ値の行が無ければ、直前の行と次の行の間に入れ、何も振り直さない', () => {
    const plan = placeAfter(row('a', 'a0'), [], row('b', 'a1'));
    expect(plan.renumber).toEqual([]);
    expect(plan.position > 'a0' && plan.position < 'a1').toBe(true);
    // 次の行が無ければ、直前の行の後
    expect(placeAfter(row('a', 'a0'), [], undefined).position > 'a0').toBe(true);
  });

  test('同じ値の続きがあれば、移す行と続きを直前の値と次の値の間に順に振り直す', () => {
    const plan = placeAfter(row('a', 'a1'), [row('b', 'a1'), row('c', 'a1')], row('d', 'a2'));
    const values = [plan.position, ...plan.renumber.map((entry) => entry.to)];
    expect(plan.renumber.map((entry) => [entry.id, entry.from])).toEqual([
      ['b', 'a1'],
      ['c', 'a1'],
    ]);
    expect([...values].sort()).toEqual(values);
    expect(new Set(values).size).toBe(3);
    for (const value of values) expect(value > 'a1' && value < 'a2').toBe(true);
  });

  test('同じ値の続きが上限を超えたら 409 の conflict（ties）で断る', () => {
    const ties = Array.from({ length: MAX_TIES + 1 }, (_, index) => row(`t${String(index).padStart(3, '0')}`, 'a1'));
    expect(() => placeAfter(row('a', 'a1'), ties, undefined)).toThrow(
      expect.objectContaining({ status: 409, code: 'conflict', details: { reason: 'ties' } }),
    );
    // 上限ちょうどなら振り直す
    expect(placeAfter(row('a', 'a1'), ties.slice(0, MAX_TIES), undefined).renumber).toHaveLength(MAX_TIES);
  });
});
