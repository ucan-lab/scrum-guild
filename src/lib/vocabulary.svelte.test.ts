import { expect, test, vi } from 'vitest';
import { t } from './vocabulary.svelte.ts';

test('t は、localStorage に何が残っていても、スクラムの言葉で引く', () => {
  vi.stubGlobal('localStorage', { getItem: () => 'game:aoba' });
  vi.stubGlobal('location', { pathname: '/aoba' });
  try {
    expect(t('workspace')).toBe('ワークスペース');
    expect(t('ac')).toBe('受け入れ基準');
    expect(t('done')).toBe('完了');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('{名前} を持つ項目は params で埋める', () => {
  expect(t('workspaceCreated', { workspace: t('workspace') })).toContain('ワークスペース');
});
