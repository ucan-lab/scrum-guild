import { afterEach, expect, test, vi } from 'vitest';

// 覚えた値は読み込みの時点で読むので、モジュールを読み直す。document は theme の処理が触るので最小の形で差し替える
async function load(stored: Record<string, string>) {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  vi.resetModules();
  const organization = await import('./organization.svelte.ts');
  const vocabulary = await import('./vocabulary.svelte.ts');
  return { store, organization, vocabulary };
}

afterEach(() => vi.unstubAllGlobals());

const view = (vocabulary: 'game' | 'scrum') =>
  ({
    me: { theme: null },
    organization: { vocabulary, theme: null },
  }) as unknown as Parameters<typeof import('./organization.svelte.ts').applyOrganization>[0];

test('applyOrganization は組織の言葉づかいを当てて覚え、resetToDefaults は既定に戻して消す', async () => {
  const { store, organization, vocabulary } = await load({});
  organization.applyOrganization(view('game'));
  expect(vocabulary.vocabularies).toEqual({ organization: 'game', workspace: 'game' });
  expect(store.get('sg-vocabulary')).toBe('game');

  organization.resetToDefaults();
  expect(vocabulary.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
  expect(store.has('sg-vocabulary')).toBe(false);
});

test('applyInvitedOrganization は画面にだけ当て、覚えず、前に別の組織で覚えた値も消す', async () => {
  const { store, organization, vocabulary } = await load({ 'sg-vocabulary': 'game' });
  organization.applyInvitedOrganization({ vocabulary: 'scrum', theme: 'simple' } as never);
  expect(vocabulary.vocabularies).toEqual({ organization: 'scrum', workspace: 'scrum' });
  expect(store.has('sg-vocabulary')).toBe(false);

  organization.applyInvitedOrganization({ vocabulary: 'game', theme: 'simple' } as never);
  expect(vocabulary.vocabularies.organization).toBe('game');
  expect(store.has('sg-vocabulary')).toBe(false);
});
