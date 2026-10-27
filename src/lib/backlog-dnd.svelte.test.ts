import { describe, expect, test, vi } from 'vitest';
import { BacklogDnd } from './backlog-dnd.svelte.ts';
import { indexTree, resolveDrop, ROOT, type Drop } from './backlog-drop.ts';

const index = indexTree({
  openEpics: [],
  storyLists: { [ROOT]: [{ id: 's1', open: true }] },
  taskLists: { s1: ['t1', 't2'], [ROOT]: ['t3'] },
  completedTasks: [],
});

// t3（親なし）を、ストーリー s1 の行に重ねて落とした結果
const drop = resolveDrop(index, { kind: 'task', id: 't3' }, { kind: 'story', id: 's1' }, 'into') as Drop;

function setup() {
  const onDrop = vi.fn();
  const onStale = vi.fn();
  const dnd = new BacklogDnd({ index: () => index, enabled: () => true, onDrop, onStale });
  return { dnd, onDrop, onStale };
}

describe('BacklogDnd のドラッグの取りやめ', () => {
  test('つかんで離すと、落とした結果を onDrop に渡し、印を消す', () => {
    const { dnd, onDrop } = setup();
    dnd.grab({ kind: 'task', id: 't3' });
    expect(dnd.isDragging('task', 't3')).toBe(true);
    dnd.hover(drop);
    expect(dnd.mark).toEqual(drop.mark);
    dnd.release(drop);
    expect(onDrop).toHaveBeenCalledWith(drop);
    expect(dnd.item).toBeNull();
    expect(dnd.mark).toBeNull();
  });

  test('つかんでいる間に木が読み直されたら（reset）、そのドラッグは取りやめ、離しても onDrop を呼ばず、取りやめを知らせる', () => {
    const { dnd, onDrop, onStale } = setup();
    dnd.grab({ kind: 'task', id: 't3' });
    dnd.hover(drop);
    dnd.reset();
    // 読み直しで、つかんでいる行と印は捨てる
    expect(dnd.item).toBeNull();
    expect(dnd.mark).toBeNull();
    // その後の動きでも印を出さず、離しても送らない
    dnd.hover(drop);
    expect(dnd.mark).toBeNull();
    dnd.release(drop);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  test('読み直しの後に落とせない場所で離したときは、取りやめを知らせない', () => {
    const { dnd, onStale } = setup();
    dnd.grab({ kind: 'task', id: 't3' });
    dnd.reset();
    dnd.release(null);
    expect(onStale).not.toHaveBeenCalled();
  });

  test('読み直しの後につかみ直したドラッグは、通常どおり落とせる', () => {
    const { dnd, onDrop } = setup();
    dnd.grab({ kind: 'task', id: 't3' });
    dnd.reset();
    dnd.grab({ kind: 'task', id: 't3' });
    dnd.release(drop);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  test('落とせない場所（null）で離しても、onDrop を呼ばない', () => {
    const { dnd, onDrop } = setup();
    dnd.grab({ kind: 'task', id: 't3' });
    dnd.release(null);
    expect(onDrop).not.toHaveBeenCalled();
    expect(dnd.item).toBeNull();
  });
});
