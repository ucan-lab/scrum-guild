// 完成の定義: 設定の画面で書く → バックログの木の上に畳んで出る → 詳細の引き出しの完了の操作の横に出る →
// 引き出しから完了にすると、完了の印と日時に替わる → 空にすると、どこにも出なくなる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。行を足すので、自分で作ったワークスペースで行う
import { expect, test, type Page } from '@playwright/test';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: '設定', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '設定' })).toBeVisible();
}

const DOD = ['- レビューを1人以上が通した', '- 手順書を **直した**'].join('\n');

test('完成の定義を書く → バックログと引き出しに出る → 引き出しから完了にする → 空にすると出なくなる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '掟のパーティ', 'game');
  await addTask(page, '見積もりを送る');
  await addTask(page, '議事録をまとめる');

  // 空のうちは、バックログにも引き出しにも出さない。完了の操作だけを出す
  await expect(page.locator('.dod')).toHaveCount(0);
  await page.locator('.entry', { hasText: '見積もりを送る' }).getByRole('link', { name: '見積もりを送る' }).click();
  let drawer = page.getByRole('dialog', { name: '見積もりを送る' });
  await expect(drawer.getByRole('button', { name: '完遂にする', exact: true })).toBeVisible();
  await expect(drawer.locator('.done-bar-dod')).toHaveCount(0);
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();

  // 設定の画面で書く。節は区分より前にある
  await openSettings(page);
  await expect(page.locator('.settings .setting-title').first()).toHaveText('パーティの掟');
  const field = page.getByRole('textbox', { name: 'Markdown' });
  await expect(field).toHaveValue('');
  const save = page.getByRole('button', { name: '保存する' });
  // 変えていないうちは押しても送らない
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await field.fill(`\n${DOD}\n\n`);
  await expect(save).toHaveAttribute('aria-disabled', 'false');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'パーティの掟を保存しました' })).toBeVisible();
  // 保存した形（前後の空行を落とした値）に合わせる。読み直しても残る
  await expect(field).toHaveValue(DOD);
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Markdown' })).toHaveValue(DOD);

  // バックログの木の上に、畳んで1つだけ出る
  await page.locator('.nav-item', { hasText: '掲示板' }).click();
  const dod = page.locator('details.dod');
  await expect(dod).toHaveCount(1);
  await expect(dod.locator('summary')).toHaveText('パーティの掟');
  // 開くまで本文を描かない
  await expect(dod.locator('.doc-box')).toHaveCount(0);
  await dod.locator('summary').click();
  await expect(dod.getByRole('listitem')).toHaveText(['レビューを1人以上が通した', '手順書を 直した']);
  await expect(dod.locator('strong')).toHaveText('直した');

  // 引き出しの完了の操作の横に出る。完了にすると、確かめずに送り、印と日時に替わって、印へフォーカスが移る
  const row = page.locator('.entry', { hasText: '見積もりを送る' });
  await row.getByRole('link', { name: '見積もりを送る' }).click();
  drawer = page.getByRole('dialog', { name: '見積もりを送る' });
  const bar = drawer.locator('.done-bar');
  await expect(bar.getByRole('heading', { level: 3, name: 'パーティの掟' })).toBeVisible();
  // 本文は送る領域で、題が名前。キーボードで届く
  await expect(bar.getByRole('region', { name: 'パーティの掟' })).toHaveAttribute('tabindex', '0');
  await expect(bar.getByRole('listitem')).toHaveText(['レビューを1人以上が通した', '手順書を 直した']);
  await bar.getByRole('button', { name: '完遂にする', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'クエストを完遂にしました' })).toBeVisible();
  await expect(bar.getByRole('button', { name: '完遂にする', exact: true })).toHaveCount(0);
  const mark = bar.getByRole('img', { name: '完遂' });
  await expect(mark).toBeFocused();
  await expect(bar.locator('time')).toHaveText(/^完遂 \d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}$/);
  await expect(drawer.locator('.drawer-top .chip.is-ok')).toHaveText('完遂');
  // 完成の定義は完了の後も出す
  await expect(bar.locator('.done-bar-dod')).toBeVisible();
  // 木を読み直し、完了したタスクは畳んだ件数に入る
  await expect(page.locator('.tree-folded.is-root')).toContainText('1');
  await drawer.getByRole('button', { name: '閉じる' }).click();
  await expect(drawer).toBeHidden();

  // 空にして保存すると、どこにも出さない
  await openSettings(page);
  await page.getByRole('textbox', { name: 'Markdown' }).fill('   \n  ');
  await page.getByRole('button', { name: '保存する' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'パーティの掟を空にしました' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Markdown' })).toHaveValue('');
  await page.locator('.nav-item', { hasText: '掲示板' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  await expect(page.locator('.dod')).toHaveCount(0);
  await page.locator('.entry', { hasText: '議事録をまとめる' }).getByRole('link', { name: '議事録をまとめる' }).click();
  drawer = page.getByRole('dialog', { name: '議事録をまとめる' });
  await expect(drawer.getByRole('button', { name: '完遂にする', exact: true })).toBeVisible();
  await expect(drawer.locator('.done-bar-dod')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('完成の定義が長すぎると、送らずに欄の下に理由を出す', async ({ page }) => {
  await createWorkspace(page, '長い掟のパーティ', 'game');
  await openSettings(page);
  const field = page.getByRole('textbox', { name: 'Markdown' });
  await field.fill('あ'.repeat(100_001));
  let sent = false;
  await page.route('**/api/aoba/workspace-dod-update', (route) => {
    sent = true;
    return route.continue();
  });
  await page.getByRole('button', { name: '保存する' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'パーティの掟は 100,000 字までです' })).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(sent).toBe(false);
});

test('書きかけのまま別の画面へ移ると、捨てるかを確かめる。書き続けると残り、捨てると移る', async ({ page }) => {
  await createWorkspace(page, '書きかけの掟のパーティ', 'game');
  await openSettings(page);
  const field = page.getByRole('textbox', { name: 'Markdown' });
  await field.fill('- 書きかけの掟');
  await page.locator('.nav-item', { hasText: '掲示板' }).click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '書き続ける' }).click();
  await expect(confirm).toBeHidden();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(field).toHaveValue('- 書きかけの掟');

  await page.locator('.nav-item', { hasText: '掲示板' }).click();
  await confirm.getByRole('button', { name: '捨てる' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
  await expect(page.locator('.dod')).toHaveCount(0);
});
