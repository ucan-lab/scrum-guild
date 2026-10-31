import { afterEach, expect, test, vi } from 'vitest';

// document は theme の処理が触るので最小の形で差し替える
async function load(stored: Record<string, string>) {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  const dataset: Record<string, string> = {};
  vi.stubGlobal('document', { documentElement: { dataset } });
  vi.stubGlobal('location', { pathname: '/aoba' });
  vi.resetModules();
  const organization = await import('./organization.svelte.ts');
  const vocabulary = await import('./vocabulary.svelte.ts');
  return { store, dataset, organization, vocabulary };
}

afterEach(() => vi.unstubAllGlobals());

const view = (theme: string) =>
  ({
    me: { theme: null },
    organization: { theme },
  }) as unknown as Parameters<typeof import('./organization.svelte.ts').applyOrganization>[0];

test('applyOrganization はテーマを当てても、言葉づかいを覚えず、言葉はスクラムの言葉のまま', async () => {
  const { store, dataset, organization, vocabulary } = await load({});
  organization.applyOrganization(view('medieval'));
  expect(dataset.theme).toBe('medieval');
  expect([...store.keys()]).not.toContain('sg-vocabulary');
  expect(vocabulary.t('workspace')).toBe('ワークスペース');
});

test('前に覚えていた言葉づかい（sg-vocabulary）が残っていても、画面の言葉は変わらない', async () => {
  const { organization, vocabulary } = await load({ 'sg-vocabulary': 'game:aoba' });
  organization.applyOrganization(view('simple'));
  organization.resetToDefaults();
  expect(vocabulary.t('workspace')).toBe('ワークスペース');
});

test('applyInvitedOrganization はテーマだけを画面に当て、覚えない', async () => {
  const { store, dataset, organization } = await load({});
  organization.applyInvitedOrganization({ theme: 'modern' } as never);
  expect(dataset.theme).toBe('modern');
  expect(store.size).toBe(0);
});
