import { describe, expect, test } from 'vitest';
import {
  availableOperations,
  indexTree,
  resolveDrop,
  ROOT,
  rowKey,
  type DragItem,
  type DropRow,
} from './backlog-drop.ts';

// e1 は開いたエピック、e2 は完了か中止したエピック。s5 は完了したストーリー。t8 は画面で完了にして、行が残っているタスク
const index = indexTree({
  openEpics: ['e1'],
  storyLists: {
    e1: [
      { id: 's1', open: true },
      { id: 's2', open: true },
    ],
    e2: [
      { id: 's3', open: true },
      { id: 's6', open: true },
    ],
    [ROOT]: [
      { id: 's4', open: true },
      { id: 's5', open: false },
    ],
  },
  taskLists: {
    s1: ['t1', 't2', 't3'],
    s2: [],
    s5: ['t9', 't10'],
    [ROOT]: ['t7', 't8'],
  },
  completedTasks: ['t8'],
});

const task = (id: string): DragItem => ({ kind: 'task', id });
const story = (id: string): DragItem => ({ kind: 'story', id });
const taskRow = (id: string): DropRow => ({ kind: 'task', id });
const storyRow = (id: string): DropRow => ({ kind: 'story', id });
const epicRow = (id: string): DropRow => ({ kind: 'epic', id });
const tail = (parent: 'story' | 'epic' | 'root', id = ''): DropRow => ({ kind: 'tail', parent, id });

const only = (...operations: ('before' | 'after' | 'into')[]) => ({
  before: operations.includes('before'),
  after: operations.includes('after'),
  into: operations.includes('into'),
});

describe('availableOperations（タスクを運ぶとき）', () => {
  test('タスクの行の前後に落とせる。親が完了したストーリーの下の行には落とせない', () => {
    expect(availableOperations(index, task('t1'), taskRow('t2'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, task('t1'), taskRow('t8'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, task('t1'), taskRow('t9'))).toEqual(only());
  });

  test('完了していないストーリーの行に重ねると囲む。完了したストーリーの行は何も示さない', () => {
    expect(availableOperations(index, task('t1'), storyRow('s2'))).toEqual(only('into'));
    expect(availableOperations(index, task('t1'), storyRow('s4'))).toEqual(only('into'));
    expect(availableOperations(index, task('t1'), storyRow('s5'))).toEqual(only());
  });

  test('エピックの直下へは落とせない', () => {
    expect(availableOperations(index, task('t1'), epicRow('e1'))).toEqual(only());
  });

  test('折りたたみの行と空の案内の行は前後に落とせる。親が完了したストーリーと、エピックの空の案内の行は落とせない', () => {
    expect(availableOperations(index, task('t7'), tail('story', 's2'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, task('t7'), tail('root'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, task('t7'), tail('story', 's5'))).toEqual(only());
    expect(availableOperations(index, task('t7'), tail('epic', 'e1'))).toEqual(only());
  });

  test('ストーリーの行の前後には落とせない（タスクはストーリーの間に置けない）', () => {
    const { before, after } = availableOperations(index, task('t1'), storyRow('s2'));
    expect(before || after).toBe(false);
  });

  test('今の親の中なら、親が完了したストーリーでも並べ替えられる（サーバーが断るのは親が変わるときだけ）', () => {
    expect(availableOperations(index, task('t9'), taskRow('t10'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, task('t9'), storyRow('s5'))).toEqual(only('into'));
    expect(availableOperations(index, task('t9'), tail('story', 's5'))).toEqual(only('before', 'after'));
    // 完了していない親へは移せ、別の完了した親へは移せない
    expect(availableOperations(index, task('t9'), storyRow('s2'))).toEqual(only('into'));
    expect(availableOperations(index, task('t1'), taskRow('t10'))).toEqual(only());
  });

  test('画面で完了にしたタスクは、どこにも落とせない。その行の前後には落とせる', () => {
    expect(availableOperations(index, task('t8'), taskRow('t1'))).toEqual(only());
    expect(availableOperations(index, task('t8'), storyRow('s2'))).toEqual(only());
    expect(resolveDrop(index, task('t8'), taskRow('t7'), 'before')).toBeNull();
    expect(resolveDrop(index, task('t8'), storyRow('s2'), 'into')).toBeNull();
    expect(resolveDrop(index, task('t7'), taskRow('t8'), 'after')?.move).toMatchObject({ afterId: 't8', index: 1 });
  });

  test('親なしの段が空のときの落とし先（slot）は、タスクをつかんでいるときだけ囲める', () => {
    expect(availableOperations(index, task('t1'), { kind: 'slot', parent: 'task-root' })).toEqual(only('into'));
    expect(availableOperations(index, task('t1'), { kind: 'slot', parent: 'story-root' })).toEqual(only());
  });
});

describe('availableOperations（ストーリーを運ぶとき）', () => {
  test('ストーリーの行の前後に落とせる。親のエピックが完了か中止していれば落とせない', () => {
    expect(availableOperations(index, story('s1'), storyRow('s2'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, story('s1'), storyRow('s4'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, story('s1'), storyRow('s3'))).toEqual(only());
  });

  test('完了も中止もしていないエピックの行に重ねると囲む', () => {
    expect(availableOperations(index, story('s4'), epicRow('e1'))).toEqual(only('into'));
    expect(availableOperations(index, story('s4'), epicRow('e2'))).toEqual(only());
  });

  test('エピックの空の案内の行は前後に落とせる。ストーリーの折りたたみの行とタスクの行には落とせない', () => {
    expect(availableOperations(index, story('s4'), tail('epic', 'e1'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, story('s4'), tail('epic', 'e2'))).toEqual(only());
    expect(availableOperations(index, story('s4'), tail('story', 's2'))).toEqual(only());
    expect(availableOperations(index, story('s4'), taskRow('t1'))).toEqual(only());
  });

  test('今のエピックの中なら、エピックが完了か中止していても並べ替えられる', () => {
    expect(availableOperations(index, story('s3'), storyRow('s6'))).toEqual(only('before', 'after'));
    expect(availableOperations(index, story('s3'), epicRow('e2'))).toEqual(only('into'));
    expect(resolveDrop(index, story('s3'), storyRow('s6'), 'after')?.move).toMatchObject({
      parentId: 'e2',
      afterId: 's6',
      reparent: false,
    });
    // 別のエピックからは入れない
    expect(availableOperations(index, story('s1'), storyRow('s6'))).toEqual(only());
  });

  test('親のないストーリーが0件のときの落とし先（slot）は、ストーリーをつかんでいるときだけ囲める', () => {
    expect(availableOperations(index, story('s1'), { kind: 'slot', parent: 'story-root' })).toEqual(only('into'));
    expect(availableOperations(index, story('s1'), { kind: 'slot', parent: 'task-root' })).toEqual(only());
  });
});

describe('resolveDrop（タスク）', () => {
  test('同じ親の中で、行の後ろに落とすと、その行を直前にする', () => {
    const drop = resolveDrop(index, task('t1'), taskRow('t2'), 'after');
    expect(drop?.move).toEqual({
      kind: 'task',
      id: 't1',
      parentId: 's1',
      afterId: 't2',
      index: 1,
      atEnd: false,
      reparent: false,
    });
    expect(drop?.mark).toEqual({ row: taskRow('t2'), operation: 'after' });
  });

  test('先頭の行の前に落とすと、直前の行は null（先頭）', () => {
    const drop = resolveDrop(index, task('t3'), taskRow('t1'), 'before');
    expect(drop?.move).toMatchObject({ parentId: 's1', afterId: null, index: 0, reparent: false });
  });

  test('動かす行の分を除いた並びで直前の行を決める（下へ動かすとき）', () => {
    const drop = resolveDrop(index, task('t1'), taskRow('t3'), 'before');
    expect(drop?.move).toMatchObject({ afterId: 't2', index: 1 });
  });

  test('元と同じ位置（自分の行、すぐ上の行の後ろ、すぐ下の行の前）は null', () => {
    expect(resolveDrop(index, task('t2'), taskRow('t2'), 'before')).toBeNull();
    expect(resolveDrop(index, task('t2'), taskRow('t2'), 'after')).toBeNull();
    expect(resolveDrop(index, task('t2'), taskRow('t1'), 'after')).toBeNull();
    expect(resolveDrop(index, task('t2'), taskRow('t3'), 'before')).toBeNull();
  });

  test('別のストーリーの行の間に落とすと、その親へ移り、直前の行を渡す', () => {
    const drop = resolveDrop(index, task('t7'), taskRow('t2'), 'before');
    expect(drop?.move).toEqual({
      kind: 'task',
      id: 't7',
      parentId: 's1',
      afterId: 't1',
      index: 1,
      atEnd: false,
      reparent: true,
    });
  });

  test('ストーリーの行に重ねると、その配下の末尾に入る（直前の行を渡さない）', () => {
    const drop = resolveDrop(index, task('t1'), storyRow('s2'), 'into');
    expect(drop?.move).toEqual({
      kind: 'task',
      id: 't1',
      parentId: 's2',
      afterId: undefined,
      index: 0,
      atEnd: true,
      reparent: true,
    });
    expect(drop?.mark).toEqual({ row: storyRow('s2'), operation: 'into' });
  });

  test('すでに末尾にある親の行に重ねても、送らない。末尾でなければ末尾へ動かす', () => {
    expect(resolveDrop(index, task('t3'), storyRow('s1'), 'into')).toBeNull();
    expect(resolveDrop(index, task('t1'), storyRow('s1'), 'into')?.move).toMatchObject({
      parentId: 's1',
      afterId: undefined,
      index: 2,
      reparent: false,
    });
  });

  test('親のないタスクへ移す。親なしの折りたたみの行の前後は、親なしの末尾', () => {
    const drop = resolveDrop(index, task('t1'), tail('root'), 'before');
    expect(drop?.move).toMatchObject({ parentId: null, afterId: undefined, index: 2, atEnd: true, reparent: true });
    expect(resolveDrop(index, task('t8'), tail('root'), 'after')).toBeNull();
  });

  test('空の案内の行の前後は、そのストーリーの末尾', () => {
    const drop = resolveDrop(index, task('t1'), tail('story', 's2'), 'after');
    expect(drop?.move).toMatchObject({ parentId: 's2', afterId: undefined, index: 0, atEnd: true });
    expect(drop?.mark).toEqual({ row: tail('story', 's2'), operation: 'after' });
  });

  test('落とせない場所（完了したストーリー、エピックの直下、ストーリーの前後）は null', () => {
    expect(resolveDrop(index, task('t1'), storyRow('s5'), 'into')).toBeNull();
    expect(resolveDrop(index, task('t1'), epicRow('e1'), 'into')).toBeNull();
    expect(resolveDrop(index, task('t1'), storyRow('s2'), 'before')).toBeNull();
    expect(resolveDrop(index, task('t1'), taskRow('t9'), 'after')).toBeNull();
  });
});

describe('resolveDrop（ストーリー）', () => {
  test('同じエピックの中で並べ替える', () => {
    expect(resolveDrop(index, story('s1'), storyRow('s2'), 'after')?.move).toEqual({
      kind: 'story',
      id: 's1',
      parentId: 'e1',
      afterId: 's2',
      index: 1,
      atEnd: false,
      reparent: false,
    });
    expect(resolveDrop(index, story('s2'), storyRow('s1'), 'before')?.move).toMatchObject({
      parentId: 'e1',
      afterId: null,
      index: 0,
    });
  });

  test('元と同じ位置は null', () => {
    expect(resolveDrop(index, story('s2'), storyRow('s1'), 'after')).toBeNull();
    expect(resolveDrop(index, story('s1'), storyRow('s2'), 'before')).toBeNull();
    expect(resolveDrop(index, story('s1'), storyRow('s1'), 'after')).toBeNull();
  });

  test('親のないストーリーの行の前に落とすと、親なしへ移る（epic_id は null）', () => {
    expect(resolveDrop(index, story('s1'), storyRow('s4'), 'before')?.move).toEqual({
      kind: 'story',
      id: 's1',
      parentId: null,
      afterId: null,
      index: 0,
      atEnd: false,
      reparent: true,
    });
  });

  test('エピックの行に重ねると、その配下の末尾に入る。完了か中止したエピックには入らない', () => {
    expect(resolveDrop(index, story('s4'), epicRow('e1'), 'into')?.move).toEqual({
      kind: 'story',
      id: 's4',
      parentId: 'e1',
      afterId: undefined,
      index: 2,
      atEnd: true,
      reparent: true,
    });
    expect(resolveDrop(index, story('s4'), epicRow('e2'), 'into')).toBeNull();
    expect(resolveDrop(index, story('s2'), epicRow('e1'), 'into')).toBeNull();
  });

  test('完了も中止もしていないエピックの空の案内の行の前後は、そのエピックの末尾', () => {
    expect(resolveDrop(index, story('s4'), tail('epic', 'e1'), 'before')?.move).toMatchObject({
      parentId: 'e1',
      afterId: undefined,
      atEnd: true,
    });
  });

  test('ストーリーの下へは落とせない。完了か中止したエピックの下のストーリーの前後にも落とせない', () => {
    expect(resolveDrop(index, story('s1'), storyRow('s2'), 'into')).toBeNull();
    expect(resolveDrop(index, story('s4'), storyRow('s3'), 'before')).toBeNull();
    expect(resolveDrop(index, story('s1'), taskRow('t7'), 'before')).toBeNull();
  });
});

describe('resolveDrop（親なしの段が空のときの落とし先）', () => {
  // ストーリーの下にだけタスクがあり、親なしのタスクも親のないストーリーも無い木
  const sparse = indexTree({
    openEpics: ['e1'],
    storyLists: { e1: [{ id: 's1', open: true }] },
    taskLists: { s1: ['t1', 't2'] },
    completedTasks: [],
  });

  test('タスクを引き出すと、親なしの末尾に入る（直前の行を渡さない）', () => {
    const drop = resolveDrop(sparse, task('t1'), { kind: 'slot', parent: 'task-root' }, 'into');
    expect(drop?.move).toEqual({
      kind: 'task',
      id: 't1',
      parentId: null,
      afterId: undefined,
      index: 0,
      atEnd: true,
      reparent: true,
    });
    expect(drop?.mark).toEqual({ row: { kind: 'slot', parent: 'task-root' }, operation: 'into' });
  });

  test('ストーリーを引き出すと、親なしの末尾に入る', () => {
    const drop = resolveDrop(sparse, story('s1'), { kind: 'slot', parent: 'story-root' }, 'into');
    expect(drop?.move).toMatchObject({ kind: 'story', parentId: null, afterId: undefined, index: 0, reparent: true });
  });

  test('つかんだ行の種類と合わない落とし先には落とせない', () => {
    expect(resolveDrop(sparse, task('t1'), { kind: 'slot', parent: 'story-root' }, 'into')).toBeNull();
    expect(resolveDrop(sparse, story('s1'), { kind: 'slot', parent: 'task-root' }, 'into')).toBeNull();
  });
});

describe('rowKey', () => {
  test('行の種類と ID から、印を付ける要素を結ぶ名前を作る', () => {
    expect(rowKey(taskRow('t1'))).toBe('task:t1');
    expect(rowKey(storyRow('s1'))).toBe('story:s1');
    expect(rowKey(epicRow('e1'))).toBe('epic:e1');
    expect(rowKey(tail('story', 's2'))).toBe('tail:story:s2');
    expect(rowKey(tail('root'))).toBe('tail:root:');
    expect(rowKey({ kind: 'slot', parent: 'task-root' })).toBe('slot:task-root');
  });
});
