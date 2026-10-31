export const NAV_COLLAPSED_KEY = 'sg-nav-collapsed';

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

export function handleNavCollapsedStorage(event: { key: string | null; newValue: string | null }): void {
  if (event.key !== NAV_COLLAPSED_KEY) return;
  navState.collapsed = isCollapsedValue(event.newValue);
}

if (typeof window !== 'undefined') window.addEventListener('storage', handleNavCollapsedStorage);
