// 自分の設定の画面の経験値の節と、バックログの画面のチーム全体の経験値。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発のミナトは、完了したタスクの起票と完了の明細2行（seed/data.sql）。ひばり工房のミナト（同じアカウント）は、
// 完了と打ち消しをくり返した明細 52 行（合計 0）で、「続きを読む」を確かめる。
// ほかのファイルの e2e がタスクを完了にすると、あおば開発のミナトの明細とレベルは増えうるので、数は ひばり工房で確かめる
import { expect, test } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

test.describe('自分の設定（ミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('メニューの「自分の設定」から開くと、レベルの面と経験値の明細が出る', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba');
    await page.locator('.nav-item', { hasText: '自分の設定' }).click();
    await expect(page).toHaveURL(/\/aoba\/me$/);
    await expect(page.getByRole('heading', { level: 1, name: '自分の設定' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('ミナト');
    await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('自分の設定');
    await expect(page).toHaveTitle('自分の設定 - Scrum Guild');

    // レベルの面。紋章（大）、合計、次のレベルまでと見込み、ゲージ、凡例、ワークスペースごとの内訳
    const panel = page.getByRole('region', { name: 'レベル' });
    await expect(panel.locator('.emblem:not(.is-sm)')).toHaveAttribute('aria-label', /^レベル \d+$/);
    await expect(panel.locator('.xp-num')).toHaveText(/^[\d,]+XP$/);
    await expect(panel.locator('.xp-sub')).toHaveText(/^次のレベルまで [\d,]+・見込み \+[\d,]+$/);
    await expect(panel.locator('.gauge')).toHaveAttribute(
      'aria-label',
      /^次のレベルまでの \d+% を確定、\d+% が見込み$/,
    );
    await expect(panel.locator('.legend > span')).toHaveText(['確定', '見込み（クエストの完了で確定）']);
    // ほかのファイルの e2e がミナトをリーダーにしたワークスペースを足すので、受託開発チームがあることと、末尾の合計だけを見る
    await expect(panel.locator('.breakdown dt', { hasText: '受託開発チーム' })).toHaveCount(1);
    await expect(panel.locator('.breakdown .is-total dt')).toHaveText('すべてのパーティ');

    // 経験値の明細。seed の起票と完了が並ぶ（ほかのファイルが完了にした行が上に足されうる）
    await expect(page.getByRole('heading', { level: 2, name: '経験値の明細' })).toBeVisible();
    const table = page.getByRole('table', { name: '経験値の明細' });
    await expect(table.locator('thead th')).toHaveText(['確定日時', 'パーティ', '行動', '内容', 'XP']);
    const seeded = table.locator('tbody tr', { hasText: '付与の履歴を返す API を作る' });
    await expect(seeded).toHaveCount(2);
    await expect(seeded.nth(0).locator('td').nth(1)).toHaveText('受託開発チーム');
    await expect(seeded.locator('.tag')).toHaveText(['完遂', '起票']);
    await expect(seeded.locator('.xp-delta')).toHaveText(['+30', '+10']);
    await expect(page.getByText('明細をすべて表示しました')).toBeVisible();

    // アカウントのメニューの名前の横に、自分のレベルの小さい紋章
    await expect(page.locator('.account-menu-button .emblem.is-sm')).toHaveAttribute('aria-label', /^レベル \d+$/);
    expect(await collect()).toEqual([]);
  });

  test('50 件ずつ出し、「続きを読む」で次を足し、最後まで読んだらその旨を出してフォーカスを移す', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/hibari/me');
    const panel = page.getByRole('region', { name: 'レベル' });
    // 打ち消しで合計 0。レベル1、次のレベルまで 100
    await expect(panel.locator('.emblem:not(.is-sm)')).toHaveAttribute('aria-label', 'レベル 1');
    await expect(panel.locator('.xp-num')).toHaveText('0XP');
    await expect(panel.locator('.xp-sub')).toHaveText('次のレベルまで 100・見込み +0');
    await expect(panel.locator('.breakdown dt')).toHaveText(['社内ツール', 'すべてのパーティ']);
    await expect(panel.locator('.breakdown dd')).toHaveText(['0', '0']);

    const rows = page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr');
    await expect(rows).toHaveCount(50);
    // 新しい順。打ち消しは元の行動に「の打ち消し」を添えて負の値
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('完遂の打ち消し');
    await expect(rows.nth(0).locator('.xp-delta.is-minus')).toHaveText('-30');
    await expect(rows.nth(1).locator('td').nth(2)).toHaveText('完遂');
    await expect(rows.nth(1).locator('.xp-delta')).toHaveText('+30');
    await expect(rows.nth(0).locator('td').nth(3)).toHaveText('締め日の選択欄を足す');

    await page.getByRole('button', { name: '続きを読む' }).click();
    await expect(rows).toHaveCount(52);
    await expect(page.getByRole('button', { name: '続きを読む' })).toHaveCount(0);
    await expect(page.getByText('明細をすべて表示しました')).toBeFocused();
    // 一番古い行は、最初の完了
    await expect(rows.nth(51).locator('td').nth(2)).toHaveText('完遂');
    expect(await collect()).toEqual([]);
  });

  test('続きの読み込みに失敗したら、表を残して知らせ、同じボタンで読み直せる', async ({ page }) => {
    let fail = true;
    await page.route('**/api/hibari/experience-grants', async (route) => {
      const body = route.request().postDataJSON() as { before?: unknown };
      if (body.before !== undefined && fail) {
        fail = false;
        await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } });
        return;
      }
      await route.continue();
    });
    await page.goto('/hibari/me');
    const rows = page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr');
    await expect(rows).toHaveCount(50);
    await page.getByRole('button', { name: '続きを読む' }).click();
    await expect(page.getByRole('alert')).toHaveText('続きを読み込めませんでした。もう一度試してください');
    await expect(rows).toHaveCount(50);
    await page.getByRole('button', { name: '続きを読む' }).click();
    await expect(rows).toHaveCount(52);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('明細が無ければ空の状態を出す', async ({ page }) => {
    await page.route('**/api/aoba/experience-grants', (route) => route.fulfill({ json: { grants: [], next: null } }));
    await page.goto('/aoba/me');
    await expect(page.getByText('経験値の明細はまだありません')).toBeVisible();
    await expect(page.getByText('クエストを完了にすると、起票や完了の経験値がここに並びます。')).toBeVisible();
    await expect(page.getByRole('table', { name: '経験値の明細' })).toHaveCount(0);
  });

  test('面と明細が読めなければ、それぞれに失敗と「もう一度試す」を出し、読み直せる', async ({ page }) => {
    let fail = true;
    for (const name of ['experience-summary', 'experience-grants']) {
      await page.route(`**/api/hibari/${name}`, (route) =>
        fail ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }) : route.continue(),
      );
    }
    await page.goto('/hibari/me');
    await expect(page.getByRole('heading', { level: 1, name: '自分の設定' })).toBeVisible();
    await expect(page.getByText('レベルを読み込めませんでした')).toBeVisible();
    await expect(page.getByText('経験値の明細を読み込めませんでした')).toBeVisible();
    await expect(page.getByRole('button', { name: 'もう一度試す' })).toHaveCount(2);

    fail = false;
    await page.getByRole('button', { name: 'もう一度試す' }).first().click();
    await expect(page.getByRole('region', { name: 'レベル' }).locator('.xp-num')).toHaveText('0XP');
    await expect(page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr')).toHaveCount(50);
  });

  test('390px の幅でも、明細の表とレベルの面が画面からはみ出さない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/hibari/me');
    await expect(page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr')).toHaveCount(50);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('チーム全体の経験値（バックログの画面）', () => {
  test('一般のメンバーにも、見出しの中にワークスペースの全員の合計が1つの数で出る', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.page-head .team-xp')).toHaveText(/^パーティ全体の経験値[\d,]+XP$/);
  });

  test('読めなくても、バックログの画面は開き、合計だけを出さない', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    await page.route('**/api/aoba/experience-team-total', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.tree')).toBeVisible();
    await expect(page.locator('.team-xp')).toHaveCount(0);
  });
});
