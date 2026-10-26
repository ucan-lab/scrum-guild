import { describe, expect, test } from 'vitest';
import { groupParents } from './parent-options.ts';

describe('groupParents', () => {
  test('親のエピックの題ごとに、並びを保ってまとめる。親のないストーリーは見出しが null', () => {
    const { grouped, groups } = groupParents([
      { id: 'a', title: 'A', group: 'エピック1' },
      { id: 'b', title: 'B', group: 'エピック1' },
      { id: 'c', title: 'C', group: 'エピック2' },
      { id: 'd', title: 'D', group: null },
    ]);
    expect(grouped).toBe(true);
    expect(groups.map((group) => [group.label, group.options.map((option) => option.id)])).toEqual([
      ['エピック1', ['a', 'b']],
      ['エピック2', ['c']],
      [null, ['d']],
    ]);
  });

  test('どの候補も group を持たなければ、見出しを付けない', () => {
    const { grouped, groups } = groupParents([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    expect(grouped).toBe(false);
    expect(groups).toEqual([
      {
        label: null,
        options: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
        ],
      },
    ]);
  });
});
