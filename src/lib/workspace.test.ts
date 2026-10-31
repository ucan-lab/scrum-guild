import { describe, expect, test } from 'vitest';
import { settleWorkspace, type KnownWorkspace, type WorkspaceView } from './workspace.ts';

const view = (id: string): WorkspaceView => ({
  id,
  name: '青葉チーム',
  closedAt: null,
  definitionOfDone: null,
  role: 'member',
});
const known = (key: string): KnownWorkspace => ({ key, workspace: view(key.split('/')[1]!) });

describe('settleWorkspace（枠が一時的に読み直せなかったときに、前の値を保つか）', () => {
  test('読めたら、その値を使い、次に保つ値にする', () => {
    const loaded = view('w1');
    expect(settleWorkspace(null, 'aoba/w1', loaded, 0)).toEqual({
      workspace: loaded,
      known: { key: 'aoba/w1', workspace: loaded },
    });
  });

  test.each([0, 500, 502, 503])('一時的な失敗（%i）は、同じワークスペースの前の値を保つ', (status) => {
    const before = known('aoba/w1');
    expect(settleWorkspace(before, 'aoba/w1', null, status)).toEqual({ workspace: before.workspace, known: before });
  });

  test('一時的な失敗でも、別のワークスペースの値は使わない', () => {
    const before = known('aoba/w1');
    expect(settleWorkspace(before, 'aoba/w2', null, 503)).toEqual({ workspace: null, known: before });
  });

  test('前に読めた値が無ければ、一時的な失敗でも null', () => {
    expect(settleWorkspace(null, 'aoba/w1', null, 500)).toEqual({ workspace: null, known: null });
  });

  test.each([401, 403, 404, 409])('読み直しても直らない失敗（%i）は、保たず、覚えていた値も消す', (status) => {
    expect(settleWorkspace(known('aoba/w1'), 'aoba/w1', null, status)).toEqual({ workspace: null, known: null });
  });
});
