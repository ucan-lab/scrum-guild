import { applyTheme, storeTheme, type Theme, type ThemeStorage } from '../shared/theme.ts';

// localStorage を取り出すだけで例外になる環境（権限なし、プライベートモード）がある。そのときは覚えない
function storage(): ThemeStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

// 当てて、localStorage に覚える。null は属性なし（シンプル（自動））で、覚えた値も消す。
// 描く前の先当ては static/theme-init.js の役目で、ここは画面が動き出してからの切り替えを受け持つ。
// 本物の値（users.theme、なければ organizations.theme）は組織の枠が入れ、組織の外の画面は null に戻す（organization.svelte.ts）
export function setTheme(theme: Theme | null): void {
  applyTheme(theme, document.documentElement);
  const store = storage();
  if (store) storeTheme(store, theme);
}
