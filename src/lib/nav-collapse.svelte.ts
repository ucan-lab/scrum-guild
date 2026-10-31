export const NAV_COLLAPSED_KEY = 'sg-nav-collapsed';
// 左のメニュー（nav）の id。開閉のボタンの aria-controls が指す
export const NAV_MENU_ID = 'app-nav';

function isCollapsedValue(value: string | null): boolean {
  return value === 'true';
}

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function readNavCollapsed(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return isCollapsedValue(store.getItem(NAV_COLLAPSED_KEY));
  } catch {
    return false;
  }
}

export const navState = $state({ collapsed: readNavCollapsed() });

// 覚えられない端末（localStorage が拒まれる）でも、押したら今の画面では開閉する。覚えないだけで、次に開くと広げた状態に戻る
export function setNavCollapsed(collapsed: boolean): void {
  navState.collapsed = collapsed;
  try {
    storage()?.setItem(NAV_COLLAPSED_KEY, String(collapsed));
  } catch {
    // 容量超過や拒否は、覚えないだけにする
  }
}

// 別のタブでの変更を追う。key が null なのは別のタブの localStorage.clear() で、既定（広げた状態）に戻す。
// 値は 'true' と 'false' と消去（null）だけを当て、それ以外は今の状態を保つ（drawer.svelte.ts と同じ扱い）
export function handleNavCollapsedStorage(event: { key: string | null; newValue: string | null }): void {
  if (event.key === null) {
    navState.collapsed = false;
    return;
  }
  if (event.key !== NAV_COLLAPSED_KEY) return;
  if (event.newValue === null || event.newValue === 'false') navState.collapsed = false;
  else if (event.newValue === 'true') navState.collapsed = true;
}

export function listenNavCollapsedStorage(target: Pick<Window, 'addEventListener'>): void {
  target.addEventListener('storage', handleNavCollapsedStorage);
}

if (typeof window !== 'undefined') listenNavCollapsedStorage(window);
