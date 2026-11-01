import { expect, test } from 'vitest';
import { visibleNav } from './nav.ts';

test.each([false, true])(
  'ワークスペースの有無（%s）によらず、左のメニューにアカウントと組織の入口を出さない',
  (hasWorkspace) => {
    for (const inWorkspaceScreen of [false, true]) {
      for (const isAdmin of [false, true]) {
        const labels = visibleNav(undefined, {
          hasWorkspace,
          inWorkspaceScreen,
          isAdmin,
          workspaceId: 'w1',
        }).flatMap((section) => section.items.map((item) => item.label));
        expect(labels).not.toContain('pageMe');
        expect(labels).not.toContain('pageOrgAdmin');
        if (!inWorkspaceScreen) expect(labels).toEqual(['pageToday']);
      }
    }
  },
);

test('ワークスペースの設定は、管理者かリーダーのときだけ残す', () => {
  const labels = (options: { isAdmin?: boolean; isLeader?: boolean }) =>
    visibleNav(undefined, {
      hasWorkspace: false,
      inWorkspaceScreen: true,
      workspaceId: 'w1',
      ...options,
    }).flatMap((section) => section.items.map((item) => item.label));
  expect(labels({ isAdmin: true })).toContain('pageSettings');
  expect(labels({ isLeader: true })).toContain('pageSettings');
  expect(labels({})).not.toContain('pageSettings');
});
