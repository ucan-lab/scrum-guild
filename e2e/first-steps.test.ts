// 最初にやること。今日やることの先頭に、ロールごとの手順が出ること、済みの印、主ボタン、行から次の画面へ移れること、
// 必須が済んだ後や読めなかったときに面が出ないことを確かめる。
// 手順と済みは `first-steps` が今のデータから決める（test/first-steps.test.ts が確かめる）ので、ここでは応答をテストの中で組む。
// seed のセッション（seed/sessions.ts）の Cookie で開く。seed のユーザーは必須の手順を済ませているので、差し替えなければ面は出ない
import type { Page } from '@playwright/test';
import { firstSteps } from '../src/shared/operations/organization/index.ts';
import type { FirstStep } from '../src/shared/operations/organization/first-steps.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { failOperation, mockOperation } from './operations.ts';

const WORKSPACE = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };

function step(key: FirstStep['key'], done: boolean, overrides: Partial<FirstStep> = {}): FirstStep {
  return { key, done, optional: false, workspace: WORKSPACE, ...overrides };
}

const MEMBER_STEPS: FirstStep[] = [
  step('joined_workspace', true),
  step('prepare_task', false),
  step('mark_today', false, { optional: true }),
];

const LEADER_STEPS: FirstStep[] = [
  step('became_leader', true),
  step('invite_members', false),
  step('first_backlog_task', false),
  step('start_sprint', false, { optional: true }),
];

const ADMIN_STEPS: FirstStep[] = [
  step('became_admin', true, { workspace: null }),
  step('create_workspace', false, { workspace: null }),
  step('invite_by_admin', false, { optional: true, workspace: null }),
  step('register_holiday', false, { optional: true, workspace: null }),
];

function panel(page: Page) {
  return page.getByRole('region', { name: '最初にやること', exact: true });
}

test.describe('一般', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('先頭に手順が並び、済んだ手順には済みの印、任意の手順には「任意」が付く。進み具合も出る', async ({ page }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: 'member', steps: MEMBER_STEPS });
    await page.goto('/aoba');

    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('.step-title')).toHaveText([/受託開発チーム」に入る/, /自分のタスクを用意する/]);
    await expect(panel(page).locator('.step.is-done')).toHaveCount(1);
    await expect(panel(page)).toContainText('1 / 2 済み');
    // 面は今日やることの区分より前（先頭）に置く
    const panelBox = await panel(page).boundingBox();
    const sectionBox = await page.getByRole('region', { name: '今日やると決めたもの' }).boundingBox();
    expect(panelBox!.y).toBeLessThan(sectionBox!.y);
  });

  test('未完の必須の手順に主ボタンが付き、押すとバックログへ移る', async ({ page }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: 'member', steps: MEMBER_STEPS });
    await page.goto('/aoba');

    const open = panel(page).getByRole('link', { name: 'バックログを開く' });
    await expect(open).toHaveClass(/is-primary/);
    await open.click();
    await expect(page).toHaveURL(`/aoba/w/${WORKSPACE.id}`);
  });

  test('必須が済んでいれば（応答が空）面は出ない', async ({ page }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: null, steps: [] });
    await page.goto('/aoba');

    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test('seed の一般のユーザーは起票を済ませているので、差し替えなくても面は出ない', async ({ page }) => {
    await page.goto('/aoba');

    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test('手順を読めなかったときは面だけを省き、今日やることは出す', async ({ page }) => {
    await failOperation(page, firstSteps, { slug: 'aoba' }, 500, 'internal');
    await page.goto('/aoba');

    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });
});

test.describe('リーダー', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('招待とバックログの最初のタスクが必須で、スプリントは任意。主ボタンは最初の未完の手順にだけ付く', async ({
    page,
  }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: 'leader', steps: LEADER_STEPS });
    await page.goto('/aoba');

    await expect(panel(page).locator('.step-title')).toHaveText([
      /リーダーになる/,
      /メンバーを招待する/,
      /バックログに最初のタスクを入れる/,
      /最初のスプリントを作って始める/,
    ]);
    await expect(panel(page).locator('.step-title .chip')).toHaveText(['任意']);
    await expect(panel(page).locator('.btn.is-primary')).toHaveCount(1);
    await expect(panel(page).getByRole('link', { name: 'メンバーを招待する' })).toHaveClass(/is-primary/);
    await expect(panel(page).getByRole('link', { name: '計画を開く' })).not.toHaveClass(/is-primary/);
  });

  test('招待の行からメンバーの画面へ、スプリントの行から計画の画面へ移れる', async ({ page }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: 'leader', steps: LEADER_STEPS });
    await page.goto('/aoba');

    await panel(page).getByRole('link', { name: 'メンバーを招待する' }).click();
    await expect(page).toHaveURL(`/aoba/w/${WORKSPACE.id}/members`);

    await page.goBack();
    await panel(page).getByRole('link', { name: '計画を開く' }).click();
    await expect(page).toHaveURL(`/aoba/w/${WORKSPACE.id}/plan`);
  });

  test('必須が済み、任意のスプリントが未完でも、応答が空なら面は出ない', async ({ page }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: null, steps: [] });
    await page.goto('/aoba');

    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });
});

test.describe('ワークスペースの無い管理者', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('ワークスペースを作る手順が必須で、招待と組織の休日は任意。主ボタンから作るダイアログが開く', async ({
    page,
  }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: 'admin', steps: ADMIN_STEPS });
    await page.goto('/aoba');

    await expect(panel(page).locator('.step-title')).toHaveText([
      /あおば開発」の管理者になる/,
      /最初のワークスペースを作る/,
      /メンバーを招待する/,
      /組織の休日を登録する/,
    ]);
    await expect(panel(page).locator('.step-title .chip')).toHaveText(['任意', '任意']);

    const create = panel(page).getByRole('button', { name: 'ワークスペースを作る' });
    await expect(create).toHaveClass(/is-primary/);
    await create.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('組織の休日の行から組織の管理の画面へ移れる', async ({ page }) => {
    await mockOperation(page, firstSteps, { slug: 'aoba' }, { role: 'admin', steps: ADMIN_STEPS });
    await page.goto('/aoba');

    await panel(page).getByRole('link', { name: '組織の管理を開く' }).click();
    await expect(page).toHaveURL('/aoba/admin');
  });
});
