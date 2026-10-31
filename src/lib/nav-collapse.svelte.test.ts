import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  handleNavCollapsedStorage,
  listenNavCollapsedStorage,
  navState,
  NAV_COLLAPSED_KEY,
  readNavCollapsed,
  setNavCollapsed,
} from './nav-collapse.svelte.ts';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  vi.unstubAllGlobals();
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  navState.collapsed = false;
});

function storage(value: string | null = null) {
  const values = new Map<string, string>();
  if (value !== null) values.set(NAV_COLLAPSED_KEY, value);
  const store = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, next: string) => values.set(key, next)),
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

describe('左のメニューの開閉の既定', () => {
  test('未設定と不正な値は広げた状態', () => {
    expect(readNavCollapsed()).toBe(false);
    storage('yes');
    expect(readNavCollapsed()).toBe(false);
  });

  test('折りたたみ状態を保存し、状態にも反映する', () => {
    const store = storage();
    setNavCollapsed(true);
    expect(store.setItem).toHaveBeenCalledWith(NAV_COLLAPSED_KEY, 'true');
    expect(navState.collapsed).toBe(true);
    setNavCollapsed(false);
    expect(store.setItem).toHaveBeenLastCalledWith(NAV_COLLAPSED_KEY, 'false');
    expect(navState.collapsed).toBe(false);
  });

  test('localStorage が使えないときは広げた状態で読み、押せば今の画面では畳める', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(readNavCollapsed()).toBe(false);
    expect(() => setNavCollapsed(true)).not.toThrow();
    expect(navState.collapsed).toBe(true);
  });

  test('保存が失敗しても落ちず、状態は替わる', () => {
    const store = storage();
    store.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setNavCollapsed(true)).not.toThrow();
    expect(navState.collapsed).toBe(true);
  });
});

describe('ほかのタブでの変更', () => {
  test('キーの true と false を当てる', () => {
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'true' });
    expect(navState.collapsed).toBe(true);
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'false' });
    expect(navState.collapsed).toBe(false);
  });

  test('知らない値と別のキーは、今の状態を保つ', () => {
    navState.collapsed = true;
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: 'unknown' });
    expect(navState.collapsed).toBe(true);
    handleNavCollapsedStorage({ key: 'sg-theme', newValue: 'false' });
    expect(navState.collapsed).toBe(true);
  });

  test('キーの消去（removeItem）と、別のタブの clear() は広げた状態に戻す', () => {
    navState.collapsed = true;
    handleNavCollapsedStorage({ key: NAV_COLLAPSED_KEY, newValue: null });
    expect(navState.collapsed).toBe(false);
    navState.collapsed = true;
    handleNavCollapsedStorage({ key: null, newValue: null });
    expect(navState.collapsed).toBe(false);
  });

  test('storage のイベントを受ける', () => {
    const addEventListener = vi.fn();
    listenNavCollapsedStorage({ addEventListener });
    expect(addEventListener).toHaveBeenCalledWith('storage', handleNavCollapsedStorage);
  });
});

test('保存された true を読むと畳んだ状態', () => {
  storage('true');
  expect(readNavCollapsed()).toBe(true);
});
