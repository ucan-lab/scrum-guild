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

// 順を空へ戻す（持ち主を問わず、置いてすぐ片付ける）
function clearOrder(): void {
  const owner = Symbol('clear');
  provideTaskOrder(owner, []);
  releaseTaskOrder(owner);
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
    target: { tagName: 'BUTTON', closest: () => null, isContentEditable: false } as unknown as EventTarget,
    ...overrides,
  };
}

// 本物の要素のように、tagName と type を持ち、closest は自分のタグが並べたセレクタにあれば自分を返す
function targetOf(tagName: string, type?: string, isContentEditable = false): EventTarget {
  return {
    tagName,
    type,
    closest: (selector: string) =>
      selector
        .split(',')
        .map((part) => part.trim().toUpperCase())
        .includes(tagName)
        ? {}
        : null,
    isContentEditable,
  } as unknown as EventTarget;
}

// 文字や数字を入れる型。ブラウザは type 属性が無いか不明な input を text として返す
const TEXT_TYPES = [
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
];
// 文字を打たない型（ポイントの radio など）。フォーカスがあっても移れる
const NON_TEXT_TYPES = ['radio', 'checkbox', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'];

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

  test.each(TEXT_TYPES)('文字や数字を入れる input（%s）の中では移らない', (type) => {
    expect(stepOfKey(keyEvent({ target: targetOf('INPUT', type) }))).toBeNull();
  });

  test('type が無い input（text として扱う）、textarea、select、contenteditable の中では移らない', () => {
    expect(stepOfKey(keyEvent({ target: targetOf('INPUT', undefined) }))).toBeNull();
    expect(stepOfKey(keyEvent({ target: targetOf('INPUT', '') }))).toBeNull();
    expect(stepOfKey(keyEvent({ target: targetOf('TEXTAREA') }))).toBeNull();
    expect(stepOfKey(keyEvent({ target: targetOf('SELECT') }))).toBeNull();
    expect(stepOfKey(keyEvent({ target: targetOf('DIV', undefined, true) }))).toBeNull();
  });

  test.each(NON_TEXT_TYPES)('文字を打たない input（%s）にフォーカスがあっても移る', (type) => {
    expect(stepOfKey(keyEvent({ key: ']', target: targetOf('INPUT', type) }))).toBe(1);
    expect(stepOfKey(keyEvent({ key: '[', target: targetOf('INPUT', type) }))).toBe(-1);
  });

  test('ボタンやリンクにフォーカスがあっても移る', () => {
    expect(stepOfKey(keyEvent({ target: targetOf('BUTTON') }))).toBe(1);
    expect(stepOfKey(keyEvent({ target: targetOf('A') }))).toBe(1);
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

  // 次のフレームで走る関数の列。フレームを手で進める
  let frames: (() => void)[] = [];
  const cancelled = new Set<number>();

  afterEach(() => {
    vi.unstubAllGlobals();
    observers.length = 0;
    frames = [];
    cancelled.clear();
    clearOrder();
  });

  function stubBrowser(): void {
    vi.stubGlobal('MutationObserver', FakeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => cancelled.add(handle));
  }

  // 溜まったフレームを1回進める（取り消したものは走らせない）
  function runFrame(): void {
    const pending = frames;
    frames = [];
    pending.forEach((callback, index) => {
      if (!cancelled.has(index + 1)) callback();
    });
  }

  function track(rows: FakeRow[]) {
    stubBrowser();
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

  test('行の出入りと畳む／開くを見て、次のフレームで順を置き直す', () => {
    stubBrowser();
    // 行は参照で渡し、後から差し替える
    const elements = { current: fakeRoot([{ id: 'a' }, { id: 'b' }]) };
    const root = { querySelectorAll: () => elements.current.querySelectorAll() };
    trackTaskOrder(root as unknown as HTMLElement);
    expect([...taskOrder.ids]).toEqual(['a', 'b']);

    elements.current = fakeRoot([{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }]);
    observers[0]?.callback();
    runFrame();
    expect([...taskOrder.ids]).toEqual(['a', 'c']);
  });

  test('1フレームの間に何度変化しても、走査は1回だけ', () => {
    stubBrowser();
    let scans = 0;
    const root = {
      querySelectorAll: () => {
        scans++;
        return [];
      },
    };
    trackTaskOrder(root as unknown as HTMLElement);
    const initial = scans;
    observers[0]?.callback();
    observers[0]?.callback();
    observers[0]?.callback();
    expect(scans).toBe(initial);
    runFrame();
    expect(scans).toBe(initial + 1);
    // 次のフレームの変化は、また1回
    observers[0]?.callback();
    observers[0]?.callback();
    runFrame();
    expect(scans).toBe(initial + 2);
  });

  test('外れたら、待っているフレームの走査は取り消して、置き直さない', () => {
    stubBrowser();
    const elements = { current: fakeRoot([{ id: 'a' }]) };
    const root = { querySelectorAll: () => elements.current.querySelectorAll() };
    const cleanup = trackTaskOrder(root as unknown as HTMLElement);
    elements.current = fakeRoot([{ id: 'a' }, { id: 'b' }]);
    observers[0]?.callback();
    cleanup();
    runFrame();
    expect([...taskOrder.ids]).toEqual([]);
  });

  test('順が変わらなければ置き直さない', () => {
    stubBrowser();
    const root = fakeRoot([{ id: 'a' }, { id: 'b' }]);
    trackTaskOrder(root as unknown as HTMLElement);
    const before = taskOrder.ids;
    observers[0]?.callback();
    runFrame();
    expect(taskOrder.ids).toBe(before);
  });

  test('2つ重ねて付けても、先に付けた方の片付けが後から付けた方の順を消さない', () => {
    stubBrowser();
    const cleanupA = trackTaskOrder(fakeRoot([{ id: 'a1' }, { id: 'a2' }]) as unknown as HTMLElement);
    const cleanupB = trackTaskOrder(fakeRoot([{ id: 'b1' }, { id: 'b2' }]) as unknown as HTMLElement);
    expect([...taskOrder.ids]).toEqual(['b1', 'b2']);
    cleanupA();
    expect([...taskOrder.ids]).toEqual(['b1', 'b2']);
    cleanupB();
    expect([...taskOrder.ids]).toEqual([]);
  });
});

describe('持ち主つきの順', () => {
  afterEach(clearOrder);

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
