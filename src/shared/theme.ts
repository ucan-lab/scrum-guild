// テーマの値と、data-theme に当てる処理。画面の store と、描く前に先当てする static/theme-init.js の両方がこの値を使う
// （static/theme-init.js は import できないので、値の一致は scripts/theme.test.ts が確かめる）。
// scripts/ と Worker の型の検査からも読むので、Node の型の除去で動く書き方に留め（enum を使わない）、DOM の型に頼らない。
import type { DictionaryKey } from './vocabulary.ts';

// DB の列挙（users.theme、organizations.theme）と同じ値。属性がなければシンプル（自動）
export const themes = ['simple', 'simple_light', 'simple_dark', 'medieval', 'modern'] as const;
export type Theme = (typeof themes)[number];

// テーマを選ぶ設定の画面が使う、テーマごとの辞書のキー。今は画面から使わないが、全テーマに辞書の名前があることを
// scripts/theme.test.ts が確かめる（テーマを足したとき、辞書の名前の足し忘れを止める）
export const themeLabelKeys: Record<Theme, DictionaryKey> = {
  simple: 'themeSimple',
  simple_light: 'themeSimpleLight',
  simple_dark: 'themeSimpleDark',
  medieval: 'themeMedieval',
  modern: 'themeModern',
};

// 描く前に読むので、static/theme-init.js と同じキーにする
export const themeStorageKey = 'sg-theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (themes as readonly string[]).includes(value);
}

// document.documentElement の形のうち、使う部分だけ
export type ThemeTarget = { dataset: { theme?: string } };

// null は属性なし（シンプル（自動））
export function applyTheme(theme: Theme | null, target: ThemeTarget): void {
  if (theme) target.dataset.theme = theme;
  else delete target.dataset.theme;
}

// localStorage の形のうち、使う部分だけ（Worker の型には DOM の Storage が無い）
export type ThemeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// localStorage が使えない（プライベートモード、権限なし）ときも落ちず、覚えていないものとして扱う
export function readStoredTheme(storage: Pick<ThemeStorage, 'getItem'>): Theme | null {
  try {
    const value = storage.getItem(themeStorageKey);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeTheme(storage: Pick<ThemeStorage, 'setItem' | 'removeItem'>, theme: Theme | null): void {
  try {
    if (theme) storage.setItem(themeStorageKey, theme);
    else storage.removeItem(themeStorageKey);
  } catch {
    // 覚えられなくても、この画面の間は当たっている
  }
}
