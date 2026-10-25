import { applyTheme, readStoredTheme, storeTheme, type Theme, type ThemeStorage } from '../shared/theme.ts';

// localStorage を取り出すだけで例外になる環境（権限なし、プライベートモード）がある。そのときは覚えない
function storage(): ThemeStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

// 今のテーマ。null は属性なし（シンプル（自動））。
// 描く前の先当ては static/theme-init.js の役目で、ここは画面が動き出してから値を持ち、切り替えを受け持つ。
// 本物の値（users.theme、なければ organizations.theme）は組織の枠が入れる（organization.svelte.ts）
export const themeState: { current: Theme | null } = $state({
  current: readStoredThemeOrNull(),
});

function readStoredThemeOrNull(): Theme | null {
  const store = storage();
  return store ? readStoredTheme(store) : null;
}

// 当てて、localStorage に覚える
export function setTheme(theme: Theme | null): void {
  themeState.current = theme;
  applyTheme(theme, document.documentElement);
  const store = storage();
  if (store) storeTheme(store, theme);
}
