import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  consumeOverlayHandoff,
  drawerState,
  effectiveTaskOpenMode,
  handleTaskOpenModeStorage,
  markOverlayHandoff,
  openTaskTab,
  pickTaskOpenMode,
  readTaskOpenMode,
  setTaskOpenMode,
  taskDetailHref,
  taskLinkAttrs,
  taskOpenModes,
  TASK_OPEN_MODE_KEY,
} from './drawer.svelte.ts';
import { toasts } from './toast.svelte.ts';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  vi.unstubAllGlobals();
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  drawerState.mode = 'side';
});

function storage(value: string | null = null) {
  const values = new Map<string, string>();
  if (value !== null) values.set(TASK_OPEN_MODE_KEY, value);
  const store = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, next: string) => values.set(key, next)),
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

describe('開き方の端末の既定', () => {
  test.each(taskOpenModes)('%s を保存し、次に読み込める', (mode) => {
    const store = storage();
    setTaskOpenMode(mode);
    expect(store.setItem).toHaveBeenCalledWith(TASK_OPEN_MODE_KEY, mode);
    expect(drawerState.mode).toBe(mode);
    expect(readTaskOpenMode()).toBe(mode);
  });

  test.each([null, '', 'unknown'])('未設定と不正な値 %s は横', (value) => {
    storage(value);
    expect(readTaskOpenMode()).toBe('side');
  });

  test('保存先そのものを取得できなくても横で開ける', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(readTaskOpenMode()).toBe('side');
    expect(() => setTaskOpenMode('center')).not.toThrow();
    expect(drawerState.mode).toBe('side');
  });

  test('読み書きの例外でも横になり、メモリだけに既定を残さない', () => {
    const store = storage('page');
    store.getItem.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readTaskOpenMode()).toBe('side');
    drawerState.mode = 'page';
    store.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    setTaskOpenMode('tab');
    expect(drawerState.mode).toBe('side');
  });

  test('狭い幅は真ん中を横として扱い、端末の既定は保つ', () => {
    storage('center');
    const preferred = readTaskOpenMode();
    expect(effectiveTaskOpenMode(preferred, true)).toBe('side');
    expect(effectiveTaskOpenMode(preferred, false)).toBe('center');
    expect(readTaskOpenMode()).toBe('center');
    for (const mode of ['side', 'page', 'tab'] as const) {
      expect(effectiveTaskOpenMode(mode, true)).toBe(mode);
    }
  });

  test('行のURLは横・真ん中では元の絞り込みを保ち、ページ・タブでは詳細だけを指す', () => {
    vi.stubGlobal('location', { href: 'https://example.com/aoba/w/workspace/plan' });
    const href = '/aoba/w/workspace/plan?q=title&task=task-id';
    for (const mode of taskOpenModes) {
      drawerState.mode = mode;
      expect(taskDetailHref(href)).toBe(mode === 'page' || mode === 'tab' ? '/aoba/w/workspace/tasks/task-id' : href);
    }
  });
});

describe('押した形の扱い', () => {
  test('描いている形と同じ形を押すと、移らずに既定だけを保存する', () => {
    const store = storage('page');
    drawerState.mode = 'page';
    expect(pickTaskOpenMode('side', 'side')).toBe('stay');
    expect(store.setItem).toHaveBeenCalledWith(TASK_OPEN_MODE_KEY, 'side');
    expect(drawerState.mode).toBe('side');
  });

  test('狭い幅で真ん中の既定を横に描いているとき、横を押すと既定が横になる', () => {
    storage('center');
    drawerState.mode = 'center';
    expect(pickTaskOpenMode('side', effectiveTaskOpenMode('center', true))).toBe('stay');
    expect(drawerState.mode).toBe('side');
  });

  test('描いている形と違う形を押したときは、移る側が確かめた後に保存するので、ここでは保存しない', () => {
    const store = storage('side');
    drawerState.mode = 'side';
    expect(pickTaskOpenMode('page', 'side')).toBe('move');
    expect(store.setItem).not.toHaveBeenCalled();
    expect(drawerState.mode).toBe('side');
  });
});

describe('新しいタブを開く', () => {
  afterEach(() => {
    toasts.length = 0;
  });

  test('開けたら opener を外して true を返す', () => {
    const opened = { opener: {} as object | null };
    const open = vi.fn(() => opened);
    vi.stubGlobal('window', { open });
    expect(openTaskTab('/aoba/w/workspace/tasks/task-id')).toBe(true);
    expect(open).toHaveBeenCalledWith('/aoba/w/workspace/tasks/task-id', '_blank');
    expect(opened.opener).toBeNull();
    expect(toasts).toHaveLength(0);
  });

  test('拒まれたら false を返し、トーストで知らせる', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    expect(openTaskTab('/aoba/w/workspace/tasks/task-id')).toBe(false);
    expect(toasts.map((toast) => toast.message)).toEqual(['新しいタブを開けませんでした']);
  });

  test('リンクの属性は、新しいタブの既定だけ target を持ち、ページ全体は先頭から読み、横と真ん中は位置を保つ', () => {
    drawerState.mode = 'tab';
    expect(taskLinkAttrs()).toEqual({ target: '_blank', rel: 'noopener noreferrer' });
    drawerState.mode = 'page';
    expect(taskLinkAttrs()).toEqual({});
    for (const mode of ['side', 'center'] as const) {
      drawerState.mode = mode;
      expect(taskLinkAttrs()).toEqual({ 'data-sveltekit-reset': 'false' });
    }
  });
});

describe('ほかのタブでの変更', () => {
  test('キーが開き方のときだけ、正しい値を取り込む', () => {
    drawerState.mode = 'side';
    handleTaskOpenModeStorage({ key: TASK_OPEN_MODE_KEY, newValue: 'page' });
    expect(drawerState.mode).toBe('page');
    handleTaskOpenModeStorage({ key: TASK_OPEN_MODE_KEY, newValue: 'unknown' });
    expect(drawerState.mode).toBe('page');
    handleTaskOpenModeStorage({ key: TASK_OPEN_MODE_KEY, newValue: null });
    expect(drawerState.mode).toBe('page');
    handleTaskOpenModeStorage({ key: 'theme', newValue: 'tab' });
    expect(drawerState.mode).toBe('page');
  });
});

describe('引き出しからページ全体への受け渡し', () => {
  test('印は1度だけ読め、読むと消える', () => {
    expect(consumeOverlayHandoff()).toBe(false);
    markOverlayHandoff();
    expect(consumeOverlayHandoff()).toBe(true);
    expect(consumeOverlayHandoff()).toBe(false);
  });
});
