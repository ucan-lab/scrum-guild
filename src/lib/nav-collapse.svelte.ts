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

export function setNavCollapsed(collapsed: boolean): void {
  const store = storage();
  if (!store) {
    navState.collapsed = false;
    return;
  }
  try {
    store.setItem(NAV_COLLAPSED_KEY, String(collapsed));
    navState.collapsed = collapsed;
  } catch {
    navState.collapsed = false;
  }
}

export function handleNavCollapsedStorage(event: { key: string | null; newValue: string | null }): void {
  if (event.key !== NAV_COLLAPSED_KEY) return;
  navState.collapsed = isCollapsedValue(event.newValue);
}

if (typeof window !== 'undefined') window.addEventListener('storage', handleNavCollapsedStorage);
