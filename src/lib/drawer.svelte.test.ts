import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  drawerState,
  effectiveTaskOpenMode,
  readTaskOpenMode,
  setTaskOpenMode,
  taskDetailHref,
  taskOpenModes,
  TASK_OPEN_MODE_KEY,
} from './drawer.svelte.ts';

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
