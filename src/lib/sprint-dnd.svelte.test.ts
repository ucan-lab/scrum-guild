import { describe, expect, test, vi } from 'vitest';
import type { SprintBoardColumn, SprintBoardTask } from '../shared/operations/sprint/index.ts';
import { SprintDnd } from './sprint-dnd.svelte.ts';
import { resolveSprintDrop, type SprintDrop } from './sprint-drop.ts';

function card(id: string): SprintBoardTask {
  return {
    id,
    title: id,
    points: null,
    assignee: null,
    completed_at: null,
    reopenable: false,
    story: null,
    due_on: null,
    repository: null,
  };
}

const columns: SprintBoardColumn[] = [
  { id: 'c1', name: '出発前', is_done: false, tasks: [card('a'), card('b')] },
  { id: 'c2', name: '遂行中', is_done: false, tasks: [card('d')] },
  { id: 'done', name: null, is_done: true, tasks: [] },
];

// a を、遂行中の d の前に落とした結果
const before = resolveSprintDrop(columns, 'a', { kind: 'card', id: 'd' }, 'before') as SprintDrop;
// a を、遂行中の列の末尾（列の囲み）に落とした結果
const into = resolveSprintDrop(columns, 'a', { kind: 'column', id: 'c2' }, 'into') as SprintDrop;

function setup() {
  const onDrop = vi.fn();
  const onStale = vi.fn();
  const dnd = new SprintDnd({ columns: () => columns, enabled: () => true, onDrop, onStale });
  return { dnd, onDrop, onStale };
}

describe('SprintDnd の印', () => {
  test('カードの前後の線は、そのカードだけに付き、列の囲みは、その列だけに付く', () => {
    const { dnd } = setup();
    dnd.grab('a');
    dnd.hover(before);
    expect(dnd.markOfCard('d')).toBe('before');
    expect(dnd.markOfCard('b')).toBeUndefined();
    expect(dnd.markOfColumn('c2')).toBeUndefined();
    dnd.hover(into);
    expect(dnd.markOfCard('d')).toBeUndefined();
    expect(dnd.markOfColumn('c2')).toBe('into');
    expect(dnd.markOfColumn('c1')).toBeUndefined();
  });

  test('つかんでいるカードは isDragging で分かり、落とせない場所（null）では印を消す', () => {
    const { dnd } = setup();
    dnd.grab('a');
    expect(dnd.isDragging('a')).toBe(true);
    expect(dnd.isDragging('b')).toBe(false);
    dnd.hover(before);
    dnd.hover(null);
    expect(dnd.mark).toBeNull();
  });
});

describe('SprintDnd のドラッグの取りやめ', () => {
  test('つかんで離すと、落とした結果を onDrop に渡し、印を消す', () => {
    const { dnd, onDrop } = setup();
    dnd.grab('a');
    dnd.hover(before);
    expect(dnd.mark).toEqual(before.mark);
    dnd.release(before);
    expect(onDrop).toHaveBeenCalledWith(before);
    expect(dnd.taskId).toBeNull();
    expect(dnd.mark).toBeNull();
  });

  test('つかんでいる間に画面が読み直されたら（reset）、そのドラッグは取りやめ、離しても onDrop を呼ばず、取りやめを知らせる', () => {
    const { dnd, onDrop, onStale } = setup();
    dnd.grab('a');
    dnd.hover(before);
    dnd.reset();
    expect(dnd.taskId).toBeNull();
    expect(dnd.mark).toBeNull();
    // その後の動きでも印を出さず、離しても送らない
    dnd.hover(before);
    expect(dnd.mark).toBeNull();
    dnd.release(before);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  test('読み直しの後に落とせない場所で離したときは、取りやめを知らせない', () => {
    const { dnd, onStale } = setup();
    dnd.grab('a');
    dnd.reset();
    dnd.release(null);
    expect(onStale).not.toHaveBeenCalled();
  });

  test('読み直しの後につかみ直したドラッグは、通常どおり落とせる', () => {
    const { dnd, onDrop } = setup();
    dnd.grab('a');
    dnd.reset();
    dnd.grab('a');
    dnd.release(into);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  test('落とせない場所（null）で離しても、onDrop を呼ばない', () => {
    const { dnd, onDrop } = setup();
    dnd.grab('a');
    dnd.release(null);
    expect(onDrop).not.toHaveBeenCalled();
    expect(dnd.taskId).toBeNull();
  });
});
