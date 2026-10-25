import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { hueOf } from '../src/lib/avatar-hue.ts';
import {
  applyTheme,
  isTheme,
  readStoredTheme,
  storeTheme,
  themeLabelKeys,
  themes,
  themeStorageKey,
  type ThemeStorage,
} from '../src/shared/theme.ts';
import { dictionary } from '../src/shared/vocabulary.ts';

// 描く前の先当て（static/theme-init.js）を、偽の localStorage と document で動かす
function runThemeInit(localStorage: unknown): { theme?: string } {
  const dataset: { theme?: string } = {};
  const document = { documentElement: { dataset } };
  vm.runInNewContext(readFileSync(new URL('../static/theme-init.js', import.meta.url), 'utf8'), {
    localStorage,
    document,
  });
  return dataset;
}

const storageWith = (value: string | null) => ({ getItem: () => value });
const brokenStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
};

describe('テーマの先当て（static/theme-init.js）', () => {
  test('覚えている値を data-theme に当てる', () => {
    for (const theme of themes) {
      assert.equal(runThemeInit(storageWith(theme)).theme, theme);
    }
  });

  test('キーは src/shared/theme.ts と同じ', () => {
    const keys: string[] = [];
    runThemeInit({
      getItem: (key: string) => {
        keys.push(key);
        return null;
      },
    });
    assert.deepEqual(keys, [themeStorageKey]);
  });

  test('覚えていない値、壊れた値は当てない', () => {
    assert.equal(runThemeInit(storageWith(null)).theme, undefined);
    assert.equal(runThemeInit(storageWith('retro')).theme, undefined);
  });

  test('localStorage が使えなくても落ちない', () => {
    assert.equal(runThemeInit(brokenStorage).theme, undefined);
    // localStorage という名前そのものが投げる環境
    const document = { documentElement: { dataset: {} } };
    const script = readFileSync(new URL('../static/theme-init.js', import.meta.url), 'utf8');
    const context = vm.createContext({ document });
    Object.defineProperty(context, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    assert.doesNotThrow(() => vm.runInContext(script, context));
  });
});

describe('テーマの値', () => {
  test('DB の列挙と同じ5つ', () => {
    assert.deepEqual([...themes], ['simple', 'simple_light', 'simple_dark', 'medieval', 'modern']);
  });

  test('どのテーマにも辞書の名前がある', () => {
    for (const theme of themes) assert.ok(themeLabelKeys[theme] in dictionary, theme);
  });

  test('isTheme は5つの値だけを通す', () => {
    assert.ok(themes.every(isTheme));
    assert.equal(isTheme('retro'), false);
    assert.equal(isTheme(null), false);
  });

  test('applyTheme は値を当て、null で属性を外す', () => {
    const target: { dataset: { theme?: string } } = { dataset: {} };
    applyTheme('medieval', target);
    assert.equal(target.dataset.theme, 'medieval');
    applyTheme(null, target);
    assert.equal('theme' in target.dataset, false);
  });

  test('覚えた値を読み戻せ、使えない localStorage でも落ちない', () => {
    const data = new Map<string, string>();
    const storage: ThemeStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
    storeTheme(storage, 'modern');
    assert.equal(readStoredTheme(storage), 'modern');
    storeTheme(storage, null);
    assert.equal(readStoredTheme(storage), null);

    const broken: ThemeStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    assert.equal(readStoredTheme(broken), null);
    assert.doesNotThrow(() => storeTheme(broken, 'modern'));
    assert.doesNotThrow(() => storeTheme(broken, null));
  });
});

describe('アバターの色相', () => {
  test('同じ id は同じ色で、0 以上 360 未満', () => {
    const id = '0196f1a2-7b3c-7d4e-8f5a-1b2c3d4e5f60';
    assert.equal(hueOf(id), hueOf(id));
    for (const sample of [id, 'u1', 'u2', '', '冒険者']) {
      const hue = hueOf(sample);
      assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${sample}: ${hue}`);
    }
  });

  test('先頭が同じ UUIDv7 でも色が散る', () => {
    const hues = new Set(
      Array.from({ length: 20 }, (_, i) => hueOf(`0196f1a2-7b3c-7d4e-8f5a-${i.toString(16).padStart(12, '0')}`)),
    );
    assert.ok(hues.size > 10, `${hues.size} 色`);
  });
});
