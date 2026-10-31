// 開いた状態（タスクの引き出し、Dialog のダイアログ、ConfirmDialog、運用の画面の管理者の指名し直し）を axe で確かめる（#334）。4つのテーマ × スクラムの言葉。
// 主な画面は e2e/a11y-screens.test.ts、除外は e2e/ui-exclusions.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。受託開発チームも社内ツールもスクラムの言葉。
// 開くだけで、作る、外すは押さない。seed の行もテーマの設定も書き換えない（ほかのファイルと並べて走るため）
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn, waitForSettled } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const TASK_ID = '019a0000-0000-7000-8000-000000000801';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('タスクの引き出しを開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(`${WORKSPACE}?task=${TASK_ID}`);
  const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'task-drawer');
});

test('タスクを作るダイアログ（Dialog）を開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  const create = page.getByRole('button', { name: '起票' });
  await expect(create).toBeVisible();
  await waitForSettled(page);
  await create.click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await expect(dialog.getByLabel('タイトル')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'task-dialog');
});

test('スプリントに入れるダイアログ（SprintTaskPicker）を開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(`${WORKSPACE}/plan`);
  const open = page.getByRole('button', { name: 'バックログから入れる: スプリント 年末の仕上げ' });
  await expect(open).toBeVisible();
  await waitForSettled(page);
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'スプリント 年末の仕上げ に入れる' });
  await expect(dialog.getByRole('group', { name: '入れるタスク' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'sprint-task-picker');
});

test('スプリントを始めるダイアログ（SprintStartDialog）を開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(`${WORKSPACE}/plan`);
  const open = page.getByRole('button', { name: '始める: スプリント 11/2〜11/15' });
  await expect(open).toBeVisible();
  await waitForSettled(page);
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'スプリントを始める' });
  await expect(dialog.getByLabel('スプリントゴール')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'sprint-start');
});

test('メンバーを外す確かめ（ConfirmDialog）を開いた状態に axe の違反が無い', async ({ page }) => {
  await page.goto(`${WORKSPACE}/members`);
  const remove = page.getByRole('button', { name: 'ハルカを外す' });
  await expect(remove).toBeVisible();
  await waitForSettled(page);
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'ハルカを外しますか' });
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'member-remove-confirm');
});

// 運用の画面の管理者の指名し直し（ReassignAdminDialog）。e2e の Worker には運用者の一覧が無いので、一覧と解決の応答は差し替える
// （e2e/operator.test.ts と同じ）。確かめた人の表示（アバター、ユーザー名、表示名）まで出した状態で測る
test('管理者の指名し直しのダイアログを開いた状態に axe の違反が無い', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'operator');
  await page.route('**/api/list-organizations', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            slug: 'hibari',
            name: 'ひばり工房',
            suspended_at: null,
            purge_on: null,
            purge_due: false,
            created_at: '2026-10-01T09:30:00.000Z',
            admin_status: 'none',
            seats: { used: 2, limit: 15 },
            workspace_count: 1,
            task_count: 12,
            attachment_quota_bytes: 32212254720,
            last_used_at: null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/resolve-github-user', (route) =>
    route.fulfill({
      json: { login_subject: '5550010', login_name: 'alice-dev', display_name: 'アリス', avatar_url: null },
    }),
  );
  await page.goto('/operator');
  const open = page.getByRole('button', { name: '「ひばり工房」の管理者を指名' });
  await expect(open).toBeVisible();
  await waitForSettled(page);
  await open.click();
  const dialog = page.getByRole('dialog', { name: '管理者を指名し直す' });
  await dialog.getByLabel('GitHub のユーザー名').fill('alice');
  await dialog.getByRole('button', { name: '確かめる' }).click();
  await expect(dialog.locator('.choice b.mono')).toHaveText('alice-dev');
  await expectNoA11yViolationsInThemes(page, 'operator-reassign');
});
