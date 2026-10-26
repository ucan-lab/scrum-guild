import { describe, expect, test } from 'vitest';
import { groupParents } from './parent-options.ts';

const first = { id: 'e1', title: 'エピック1' };
const second = { id: 'e2', title: 'エピック2' };

describe('groupParents', () => {
  test('親のエピックごとに、並びを保ってまとめる。親のないストーリーは見出しが null', () => {
    const { grouped, groups } = groupParents([
      { id: 'a', title: 'A', group: first },
      { id: 'b', title: 'B', group: first },
      { id: 'c', title: 'C', group: second },
      { id: 'd', title: 'D', group: null },
    ]);
    expect(grouped).toBe(true);
    expect(groups.map((group) => [group.label, group.options.map((option) => option.id)])).toEqual([
      ['エピック1', ['a', 'b']],
      ['エピック2', ['c']],
      [null, ['d']],
    ]);
  });

  test('同じ題の別のエピックは、別の見出しに分ける', () => {
    const { groups } = groupParents([
      { id: 'a', title: 'A', group: { id: 'e1', title: '同じ題' } },
      { id: 'b', title: 'B', group: { id: 'e2', title: '同じ題' } },
    ]);
    expect(groups.map((group) => [group.key, group.label, group.options.map((option) => option.id)])).toEqual([
      ['e1', '同じ題', ['a']],
      ['e2', '同じ題', ['b']],
    ]);
  });

  test('どの候補もエピックの下になければ（すべて親なしか、group を持たない）、見出しを付けない', () => {
    for (const options of [
      [
        { id: 'a', title: 'A', group: null },
        { id: 'b', title: 'B', group: null },
      ],
      [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
    ]) {
      const { grouped, groups } = groupParents(options);
      expect(grouped).toBe(false);
      expect(groups).toEqual([{ key: null, label: null, options }]);
    }
  });
});
