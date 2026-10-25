// 組織の休日。管理者が貼り付けて登録し（形の合わない行は理由を出す）、一覧で確かめ、消す。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。
// 登録して消すのは 2027 年の日付で、seed の休日（2026 年）とは重ねない
import { expect, test, type Page } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

function sectionOf(page: Page) {
  return page.getByRole('region', { name: '組織の休日' });
}

test.describe('管理者（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('貼り付けて登録すると、正しい行だけが入り、形の合わない行は理由とともに残る。消すと一覧から外れる', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const list = section.getByRole('list', { name: '登録した休日' });
    // seed の休日が、日付の古い順に出る
    await expect(list.getByRole('listitem').first()).toContainText('2026-11-03');
    await expect(list).toContainText('文化の日');

    const paste = section.getByLabel('貼り付けて登録');
    await paste.fill('2027-02-11 建国記念の日\n2027-02-30 無い日\n2027/2/23,天皇誕生日');
    await section.getByRole('button', { name: '登録する' }).click();

    await expect(page.getByRole('status').filter({ hasText: '2 日を登録しました' })).toBeVisible();
    await expect(list.getByRole('listitem').filter({ hasText: '2027-02-11' })).toContainText('建国記念の日');
    await expect(list.getByRole('listitem').filter({ hasText: '2027-02-23' })).toContainText('天皇誕生日');
    // 欄には直す行だけが残り、行の番号と理由を欄に結んで出す
    await expect(paste).toHaveValue('2027-02-30 無い日');
    await expect(paste).toHaveAttribute('aria-invalid', 'true');
    const problems = section.getByRole('list', { name: '登録しない行' });
    await expect(problems.getByRole('listitem')).toHaveText(['1 行目「2027-02-30 無い日」: 暦に無い日付です']);
    const describedBy = (await paste.getAttribute('aria-describedby')) ?? '';
    const errorId = describedBy.split(' ')[0]!;
    await expect(section.locator(`[id="${errorId}"]`)).toContainText('暦に無い日付です');

    // 登録済みの日付は飛ばし、名前も書き換えない
    await paste.fill('2027-02-11 書き換えた名前');
    await expect(paste).toHaveAttribute('aria-invalid', 'false');
    await section.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByRole('status').filter({ hasText: '0 日を登録しました（1 日は登録済み）' })).toBeVisible();
    await expect(list.getByRole('listitem').filter({ hasText: '2027-02-11' })).toContainText('建国記念の日');
    await expect(list).not.toContainText('書き換えた名前');
    await expect(paste).toHaveValue('');

    // 消す。確かめのダイアログは挟まず、同じ位置の次の行の削除ボタンへフォーカスが移る
    await section.getByRole('button', { name: '2027-02-11 を消す' }).click();
    await expect(page.getByRole('status').filter({ hasText: '2027-02-11 を消しました' })).toBeVisible();
    await expect(list.getByRole('listitem').filter({ hasText: '2027-02-11' })).toHaveCount(0);
    await expect(section.getByRole('button', { name: '2027-02-23 を消す' })).toBeFocused();

    // 後片付け（seed の休日だけに戻す）
    await section.getByRole('button', { name: '2027-02-23 を消す' }).click();
    await expect(list.getByRole('listitem').filter({ hasText: '2027-02-23' })).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('登録できる行が無ければ送らず、理由を出す', async ({ page }) => {
    let addCalls = 0;
    await page.route('**/api/aoba/organization-holiday-add', (route) => {
      addCalls++;
      return route.continue();
    });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    await section.getByLabel('貼り付けて登録').fill('国民の祝日・休日月日,国民の祝日・休日名称');
    await section.getByRole('button', { name: '登録する' }).click();
    await expect(section.getByRole('list', { name: '登録しない行' }).getByRole('listitem')).toHaveText([
      '1 行目「国民の祝日・休日月日,国民の祝日・休日名称」: 日付の形ではありません（2026-11-03 か 2026/11/3）',
    ]);
    expect(addCalls).toBe(0);
  });

  test('320px の幅でも、節は横にはみ出さず、削除のボタンは右端に見える', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const button = section.getByRole('button', { name: '2026-11-03 を消す' });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('組織の管理の画面は「見つからない」で、休日の節は出ない', async ({ page }) => {
    await page.goto('/aoba/admin');
    await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
    await expect(sectionOf(page)).toHaveCount(0);
    await expect(page.getByLabel('貼り付けて登録')).toHaveCount(0);
  });
});
