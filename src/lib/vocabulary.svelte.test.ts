import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// 覚えた値は読み込みの時点で読むので、テストごとにモジュールを読み直す
async function load(stored: Record<string, string>) {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.resetModules();
  return { store, mod: await import('./vocabulary.svelte.ts') };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

test('覚えたゲームの言葉で、最初の描画から組織とワークスペースの両方を始める', async () => {
  const { mod } = await load({ 'sg-vocabulary': 'game' });
  expect(mod.vocabularies).toEqual({ organization: 'game', workspace: 'game' });
  expect(mod.t('workspace')).toBe('パーティ');
});

test('覚えていない、壊れた値ならスクラムの言葉で始める', async () => {
  expect((await load({})).mod.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
  expect((await load({ 'sg-vocabulary': 'retro' })).mod.vocabularies).toEqual({
    organization: 'scrum',
    workspace: 'scrum',
  });
});

test('localStorage が使えなくても、スクラムの言葉で始まり、覚える処理も落ちない', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  });
  vi.resetModules();
  const mod = await import('./vocabulary.svelte.ts');
  expect(mod.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
  expect(() => mod.rememberVocabulary('game')).not.toThrow();
  expect(() => mod.rememberVocabulary(null)).not.toThrow();
});

test('覚える値は game か scrum で、null で消す', async () => {
  const { mod, store } = await load({});
  mod.rememberVocabulary('game');
  expect(store.get(mod.vocabularyStorageKey)).toBe('game');
  mod.rememberVocabulary(null);
  expect(store.has(mod.vocabularyStorageKey)).toBe(false);
});

test('Node のように localStorage という名前そのものが無くても落ちない', async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  const mod = await import('./vocabulary.svelte.ts');
  expect(mod.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
});
