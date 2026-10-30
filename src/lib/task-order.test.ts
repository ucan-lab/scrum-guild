import { afterEach, describe, expect, test, vi } from 'vitest';
import { adjacentTaskIds, provideTaskOrder, releaseTaskOrder, taskOrder } from './drawer.svelte.ts';
import { stepOfKey, trackTaskOrder, visibleTaskIds, type StepKeyEvent } from './task-order.ts';

type FakeRow = { id: string | null; hidden?: boolean };

// data-task-id を持つ要素の代わり。hidden は、畳んだ枝のように [hidden] の中にあること
function fakeRoot(rows: readonly FakeRow[]) {
  const elements = rows.map((row) => ({
    getAttribute: (name: string) => (name === 'data-task-id' ? row.id : null),
    closest: (selector: string) => (selector === '[hidden]' && row.hidden === true ? {} : null),
  }));
  return { querySelectorAll: () => elements };
}

describe('visibleTaskIds', () => {
  test('描かれた順に、見えている行の ID を返す', () => {
    const root = fakeRoot([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(visibleTaskIds(root as unknown as ParentNode)).toEqual(['a', 'b', 'c']);
  });

  test('畳んだ枝（hidden の中）の行は飛ばす', () => {
    const root = fakeRoot([{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }]);
    expect(visibleTaskIds(root as unknown as ParentNode)).toEqual(['a', 'c']);
  });

  test('同じタスクの行が2つあれば先の1つだけ、ID の無い要素は数えない', () => {
    const root = fakeRoot([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: '' }, { id: null }]);
    expect(visibleTaskIds(root as unknown as ParentNode)).toEqual(['a', 'b']);
  });

  test('行が無ければ空', () => {
    expect(visibleTaskIds(fakeRoot([]) as unknown as ParentNode)).toEqual([]);
  });
});

describe('adjacentTaskIds', () => {
  const ids = ['a', 'b', 'c'];

  test('途中は前と次を返す', () => {
    expect(adjacentTaskIds(ids, 'b')).toEqual({ prev: 'a', next: 'c' });
  });

  test('先頭は前が、末尾は次が null で、そこで止まる', () => {
    expect(adjacentTaskIds(ids, 'a')).toEqual({ prev: null, next: 'b' });
    expect(adjacentTaskIds(ids, 'c')).toEqual({ prev: 'b', next: null });
  });

  test('1件だけなら前も次も無い', () => {
    expect(adjacentTaskIds(['a'], 'a')).toEqual({ prev: null, next: null });
  });

  test('順に無いタスク（完了して木から外れた）と空の順は、前後を決めない', () => {
    expect(adjacentTaskIds(ids, 'x')).toBeNull();
    expect(adjacentTaskIds([], 'a')).toBeNull();
  });
});

function keyEvent(overrides: Partial<StepKeyEvent> = {}): StepKeyEvent {
  return {
    key: ']',
    keyCode: 221,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: { closest: () => null, isContentEditable: false } as unknown as EventTarget,
    ...overrides,
  };
}

function targetOf(selectorHit: boolean, isContentEditable = false): EventTarget {
  return {
    closest: (selector: string) => (selectorHit && selector.includes('textarea') ? {} : null),
    isContentEditable,
  } as unknown as EventTarget;
}

describe('stepOfKey', () => {
  test('[ は前、] は次', () => {
    expect(stepOfKey(keyEvent({ key: '[' }))).toBe(-1);
    expect(stepOfKey(keyEvent({ key: ']' }))).toBe(1);
  });

  test('ほかのキーは移らない', () => {
    expect(stepOfKey(keyEvent({ key: 'j' }))).toBeNull();
    expect(stepOfKey(keyEvent({ key: 'Escape' }))).toBeNull();
  });

  test('日本語の変換中（isComposing か keyCode 229）は移らない', () => {
    expect(stepOfKey(keyEvent({ isComposing: true }))).toBeNull();
    expect(stepOfKey(keyEvent({ keyCode: 229 }))).toBeNull();
  });

  test.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const)('%s 付きでは移らない', (modifier) => {
    expect(stepOfKey(keyEvent({ [modifier]: true }))).toBeNull();
  });

  test('押しっぱなしの繰り返しと、ほかの処理が受けたキーでは移らない', () => {
    expect(stepOfKey(keyEvent({ repeat: true }))).toBeNull();
    expect(stepOfKey(keyEvent({ defaultPrevented: true }))).toBeNull();
  });

  test('入力欄、textarea、select の中と contenteditable の中では移らない', () => {
    expect(stepOfKey(keyEvent({ target: targetOf(true) }))).toBeNull();
    expect(stepOfKey(keyEvent({ target: targetOf(false, true) }))).toBeNull();
  });

  test('キーの先が要素でなくても（document など）移れる', () => {
    expect(stepOfKey(keyEvent({ target: {} as EventTarget }))).toBe(1);
    expect(stepOfKey(keyEvent({ target: null }))).toBe(1);
  });
});

describe('trackTaskOrder', () => {
  type Callback = () => void;
  const observers: { callback: Callback; disconnect: ReturnType<typeof vi.fn> }[] = [];

  class FakeObserver {
    disconnect = vi.fn();
    constructor(callback: Callback) {
      observers.push({ callback, disconnect: this.disconnect });
    }
    observe() {}
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    observers.length = 0;
    taskOrder.ids = [];
    taskOrder.owner = null;
  });

  function track(rows: FakeRow[]) {
    vi.stubGlobal('MutationObserver', FakeObserver);
    const root = fakeRoot(rows);
    const cleanup = trackTaskOrder(root as unknown as HTMLElement);
    return { rows, cleanup };
  }

  test('付いた時点の順を置き、外れたら空へ戻す', () => {
    const { cleanup } = track([{ id: 'a' }, { id: 'b' }]);
    expect([...taskOrder.ids]).toEqual(['a', 'b']);
    cleanup();
    expect([...taskOrder.ids]).toEqual([]);
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  test('行の出入りと畳む／開くを見て、順を置き直す', () => {
    const rows: FakeRow[] = [{ id: 'a' }, { id: 'b' }];
    vi.stubGlobal('MutationObserver', FakeObserver);
    // 行は参照で渡し、後から差し替える
    const elements = { current: fakeRoot(rows) };
    const root = { querySelectorAll: () => elements.current.querySelectorAll() };
    trackTaskOrder(root as unknown as HTMLElement);
    expect([...taskOrder.ids]).toEqual(['a', 'b']);

    elements.current = fakeRoot([{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }]);
    observers[0]?.callback();
    expect([...taskOrder.ids]).toEqual(['a', 'c']);
  });

  test('順が変わらなければ置き直さない', () => {
    vi.stubGlobal('MutationObserver', FakeObserver);
    const root = fakeRoot([{ id: 'a' }, { id: 'b' }]);
    trackTaskOrder(root as unknown as HTMLElement);
    const before = taskOrder.ids;
    observers[0]?.callback();
    expect(taskOrder.ids).toBe(before);
  });
});

describe('持ち主つきの順', () => {
  afterEach(() => {
    taskOrder.ids = [];
    taskOrder.owner = null;
  });

  test('持ち主でない片付けは、あとから置かれた順を消さない', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    provideTaskOrder(first, ['a']);
    provideTaskOrder(second, ['b']);
    releaseTaskOrder(first);
    expect([...taskOrder.ids]).toEqual(['b']);
    releaseTaskOrder(second);
    expect([...taskOrder.ids]).toEqual([]);
  });
});
