// ワークスペースの作成、組織の管理の画面、ワークスペースの枠。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発の管理者はミナト、一般のユーザーはハルカ。ひばり工房のワークスペースの ID は seed/data.sql の値
import { expect, test } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

const HIBARI_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000402';

test.describe('管理者（あおば開発のミナト）', () => {
  test.use({ timezoneId: 'Asia/Tokyo' });

  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('組織の管理に、既存のワークスペースの一覧を出し、メニューに組織の管理が入る', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba');
    await page.locator('.nav-item', { hasText: '組織の管理' }).click();
    await expect(page).toHaveURL(/\/aoba\/admin$/);
    await expect(page.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();

    const row = page.locator('tbody tr', { hasText: '受託開発チーム' });
    await expect(row.getByRole('link', { name: '受託開発チーム' })).toHaveAttribute('href', /\/aoba\/w\/019a0000-/);
    // メンバー数（リーダーを含む）、リーダー数、作った日（ワークスペースのタイムゾーン）
    await expect(row.locator('td').nth(1)).toHaveText('2');
    await expect(row.locator('td').nth(2)).toHaveText('1');
    await expect(row.locator('td').nth(3)).toHaveText('2026-10-01');
    // 別の組織のワークスペースは出ない
    await expect(page.getByRole('link', { name: '社内ツール', exact: true })).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('自分をリーダーに、ゲームの言葉で作ると、そのワークスペースの画面へ移る', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    // 説明文に、選んだ言葉づかいの列と決まった欄の名前、換算、週の始まり、このブラウザのタイムゾーンを出す
    await expect(dialog.getByText(/行程は「出発前、遂行中、査定中、完遂」/)).toBeVisible();
    await expect(dialog.getByText(/決まった欄は「達成条件」/)).toBeVisible();
    await expect(dialog.getByText(/1 難易度 = 4 時間、週の始まりは月曜、タイムゾーンは Asia\/Tokyo/)).toBeVisible();
    // 最初のリーダーの既定は自分。言葉づかいの既定は組織の言葉づかい（ゲーム）
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await expect(dialog.getByRole('combobox').locator('option:checked')).toHaveText('ミナト');
    await expect(dialog.getByRole('radio', { name: /ゲームの言葉/ })).toBeChecked();
    await dialog.getByLabel('名前').fill('  保守チーム  ');
    await dialog.getByRole('button', { name: '作る' }).click();

    await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: '保守チーム' })).toBeVisible();
    // 所属しているので、所属していない印は出ない。メニューにワークスペースの節が出る
    await expect(page.getByText(/所属せず/)).toHaveCount(0);
    await expect(page.locator('.ws-select')).toContainText('保守チーム');
    await expect(page.locator('.nav-group')).toHaveText('パーティ');
    await expect(page.getByText('パーティを作りました')).toBeVisible();
    expect(await collect()).toEqual([]);

    // 一覧に出て、リーダーが1人のメンバーが1人
    await page.goto('/aoba/admin');
    const row = page.locator('tbody tr', { hasText: '保守チーム' });
    await expect(row.locator('td').nth(1)).toHaveText('1');
    await expect(row.locator('td').nth(2)).toHaveText('1');
  });

  test('別の人をリーダーにスクラムの言葉で作ると、中の言葉づかいがスクラムになり、所属していない印が出る', async ({
    page,
  }) => {
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await dialog.getByRole('radio', { name: /スクラムの言葉/ }).check();
    // 説明文が、選んだ言葉づかいの名前に替わる
    await expect(dialog.getByText(/列は「未着手、作業中、レビュー、完了」/)).toBeVisible();
    await expect(dialog.getByText(/決まった欄は「受け入れ基準」/)).toBeVisible();
    await expect(dialog.getByText(/1 ポイント = 4 時間/)).toBeVisible();
    await dialog.getByLabel('名前').fill('社内ツール改善');
    await dialog.getByRole('combobox').selectOption({ label: 'ハルカ' });
    await dialog.getByRole('button', { name: '作る' }).click();

    await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: '社内ツール改善' })).toBeVisible();
    // ワークスペースの中の言葉はスクラム。組織の言葉（ギルドマスター）はそのまま
    await expect(page.locator('.nav-group')).toHaveText('ワークスペース');
    await expect(page.getByText('このワークスペースの画面は準備中です')).toBeVisible();
    // 作った管理者は所属していない。それでも画面に入れて、印が出る
    await expect(page.locator('.topbar .chip').first()).toHaveText('所属せずギルドマスターとして開いています');

    // 画面を読み直さずにワークスペースの外へ移ると、ワークスペースの言葉は組織の言葉づかい（ゲーム）に戻り、印も消える
    await page.locator('.nav-item', { hasText: '組織の管理' }).click();
    await expect(page).toHaveURL(/\/aoba\/admin$/);
    await expect(page.getByRole('button', { name: 'パーティを作る' }).first()).toBeVisible();
    await expect(page.locator('.topbar .chip')).toHaveCount(1);
  });

  test('名前が空か51字以上だと、送らずに知らせる', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/aoba/workspace-create', (route) => {
      requests++;
      return route.continue();
    });
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();

    await dialog.getByLabel('名前').fill('   ');
    await dialog.getByRole('button', { name: '作る' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('名前を入れてください');
    await expect(dialog.getByLabel('名前')).toBeFocused();

    await dialog.getByLabel('名前').fill('あ'.repeat(51));
    await dialog.getByRole('button', { name: '作る' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('名前は 50 字までです');
    expect(requests).toBe(0);
  });

  test('送っている間は「作る」を押せず、1回しか送らない', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/aoba/workspace-create', async (route) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await dialog.getByLabel('名前').fill('二重送信の確認');
    await dialog.getByRole('button', { name: '作る' }).click();
    await expect(dialog.getByRole('button', { name: '作っています' })).toBeDisabled();
    await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
    expect(requests).toBe(1);
  });

  test('候補を読み込めないときは知らせて、もう一度試せる', async ({ page }) => {
    let fail = true;
    await page.route('**/api/aoba/workspace-leader-candidates', (route) =>
      fail ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }) : route.continue(),
    );
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByText('選べる人を読み込めませんでした')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '作る' })).toBeDisabled();
    fail = false;
    await dialog.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await expect(dialog.getByRole('button', { name: '作る' })).toBeEnabled();
  });

  test('存在しない ID と別の組織のワークスペースの ID は、同じ「見つからない」', async ({ page }) => {
    for (const id of ['no-such-workspace', HIBARI_WORKSPACE_ID]) {
      await page.goto(`/aoba/w/${id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'パーティが見つかりません' })).toBeVisible();
      await expect(page.getByText('URL が違うか、入れないパーティです。')).toBeVisible();
      // 組織の枠は残る
      await expect(page.locator('.nav-item', { hasText: '自分の今日' })).toBeVisible();
    }
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('メニューに組織の管理が出ず、/aoba/admin は「見つからない」', async ({ page }) => {
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    await expect(page.locator('.nav-item', { hasText: '組織の管理' })).toHaveCount(0);

    await page.goto('/aoba/admin');
    await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'パーティを作る' })).toHaveCount(0);
  });

  test('所属するワークスペースは開け、所属していないロールの印は出ない', async ({ page }) => {
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
    await expect(page.getByRole('heading', { level: 1, name: '受託開発チーム' })).toBeVisible();
    await expect(page.getByText(/所属せず/)).toHaveCount(0);
    await expect(page.locator('.ws-select')).toContainText('受託開発チーム');
  });
});
