import { afterEach, expect, test, vi } from 'vitest';
import { t } from './vocabulary.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

test('t は、localStorage に何が残っていても、スクラムの言葉で引く', async () => {
  // 読み込み時に localStorage を見る実装でも検出できるよう、スタブの後にモジュールを読み込む
  vi.stubGlobal('localStorage', { getItem: () => 'game:aoba' });
  vi.stubGlobal('location', { pathname: '/aoba' });
  vi.resetModules();
  const { t: fresh } = await import('./vocabulary.svelte.ts');
  expect(fresh('workspace')).toBe('ワークスペース');
  expect(fresh('ac')).toBe('受け入れ基準');
  expect(fresh('done')).toBe('完了');
});

test('{名前} を持つ項目は params で埋める', () => {
  expect(t('workspaceCreated', { workspace: t('workspace') })).toContain('ワークスペース');
});
