import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// 覚えた値は読み込みの時点で読むので、テストごとにモジュールを読み直す。path は今開いている URL の path
async function load(stored: Record<string, string>, path = '/aoba') {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal('location', { pathname: path });
  vi.resetModules();
  return { store, mod: await import('./vocabulary.svelte.ts') };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

test('今開いている組織について覚えたゲームの言葉で、最初の描画から組織とワークスペースの両方を始める', async () => {
  const { mod } = await load({ 'sg-vocabulary': 'game:aoba' });
  expect(mod.vocabularies).toEqual({ organization: 'game', workspace: 'game' });
  expect(mod.t('workspace')).toBe('パーティ');
});

test('ワークスペースの中の URL でも、先頭の slug で組織を見分ける', async () => {
  const { mod } = await load({ 'sg-vocabulary': 'game:aoba' }, '/aoba/w/019a0000-0000-7000-8000-000000000401');
  expect(mod.vocabularies.organization).toBe('game');
});

test('別の組織について覚えた値は使わない（ゲームの組織の後にスクラムの組織を直に開く）', async () => {
  const { mod } = await load({ 'sg-vocabulary': 'game:aoba' }, '/hibari');
  expect(mod.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
});

test('組織の外の URL（slug が無い、組織でない path）では、覚えた値を使わない', async () => {
  expect((await load({ 'sg-vocabulary': 'game:aoba' }, '/')).mod.vocabularies.organization).toBe('scrum');
  expect((await load({ 'sg-vocabulary': 'game:aoba' }, '/login')).mod.vocabularies.organization).toBe('scrum');
});

test('覚えていない、壊れた値ならスクラムの言葉で始める', async () => {
  expect((await load({})).mod.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
  for (const broken of ['game', 'retro:aoba', 'game:', ':aoba']) {
    expect((await load({ 'sg-vocabulary': broken })).mod.vocabularies.organization).toBe('scrum');
  }
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
  vi.stubGlobal('location', { pathname: '/aoba' });
  vi.resetModules();
  const mod = await import('./vocabulary.svelte.ts');
  expect(mod.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
  expect(() => mod.rememberVocabulary('game')).not.toThrow();
  expect(() => mod.rememberVocabulary(null)).not.toThrow();
});

test('覚える値は今開いている組織の slug を添え、null で消す', async () => {
  const { mod, store } = await load({}, '/hibari/w/x');
  mod.rememberVocabulary('game');
  expect(store.get(mod.vocabularyStorageKey)).toBe('game:hibari');
  mod.rememberVocabulary(null);
  expect(store.has(mod.vocabularyStorageKey)).toBe(false);
});

test('組織の slug が取れない URL では、覚えずに消す', async () => {
  const { mod, store } = await load({ 'sg-vocabulary': 'game:aoba' }, '/');
  mod.rememberVocabulary('game');
  expect(store.has(mod.vocabularyStorageKey)).toBe(false);
});

test('localStorage が実験的で使えない環境（Node）でも落ちない', async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  const mod = await import('./vocabulary.svelte.ts');
  expect(mod.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
});
