// 組織の管理の画面の「ユーザー」の節。管理者が一覧を見て、管理者に指名して解除し、無効にして有効に戻す。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。
// 書き換えるのは、このファイルだけが使う所属の無いソラ（指名と解除）とユイ（無効化と有効化）だけで、どちらもテストの中で元に戻す
// （seed/data.sql。ソラは承諾待ちの招待と同じログインなので、管理者にしても組織の人数は変わらない）。
// ファイルの中のテストは順に走る（集計の数を見るため）
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

function sectionOf(page: Page) {
  return page.getByRole('region', { name: 'ユーザー', exact: true });
}

function rowOf(page: Page, name: string) {
  return sectionOf(page)
    .getByRole('table', { name: '冒険者ギルドのユーザーの一覧' })
    .locator('tbody tr', { hasText: name });
}

function toast(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

test.describe('管理者（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('ユーザーを名前の順に、管理者の印、所属の数、最後に入った日とともに出し、見出しにユーザーと管理者の数を出す', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/admin');
    const table = sectionOf(page).getByRole('table', { name: '冒険者ギルドのユーザーの一覧' });
    await expect(table.getByRole('columnheader')).toHaveText([
      '名前',
      'ギルドマスター',
      '所属',
      '最後に入った日',
      '操作',
    ]);
    // アバターの頭文字は除いて読む
    await expect(table.locator('tbody tr')).toHaveCount(4);
    const names = await table.locator('tbody tr td.is-name').evaluateAll((cells) =>
      cells.map((cell) => {
        const copy = cell.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('.avatar').forEach((avatar) => avatar.remove());
        return (copy.textContent ?? '').trim();
      }),
    );
    expect(names).toEqual(['ソラ', 'ハルカ', 'ミナト', 'ユイ']);
    // ユーザーの節は、ワークスペースの節より前に並ぶ
    await expect(page.locator('.settings > .setting .setting-title').first()).toHaveText('ユーザー');

    const me = rowOf(page, 'ミナト');
    await expect(me.getByRole('checkbox', { name: 'ミナトをギルドマスターにする' })).toBeChecked();
    // 自分の行には「無効にする」を出さない
    await expect(me.getByRole('button')).toHaveCount(0);
    const haruka = rowOf(page, 'ハルカ');
    await expect(haruka.getByRole('checkbox', { name: 'ハルカをギルドマスターにする' })).not.toBeChecked();
    await expect(haruka.locator('td.is-num')).toHaveText('1');
    await expect(haruka.getByRole('button', { name: 'ハルカを無効にする' })).toHaveText('無効にする');
    // 最後に入った日は、ブラウザのタイムゾーン（東京）の日付。入ったことの無い人は「—」
    await expect(rowOf(page, 'ソラ').locator('td.mono')).toHaveText('2026-10-12');
    // 「—」は読み上げに渡さず、見えない文字で「まだ入っていません」を添える
    await expect(rowOf(page, 'ユイ').locator('td.mono [aria-hidden="true"]')).toHaveText('—');
    await expect(rowOf(page, 'ユイ').locator('td.mono .visually-hidden')).toHaveText('まだ入っていません');

    const tallies = page.locator('.tally > div');
    await expect(tallies.nth(0)).toHaveText('ユーザー 4');
    await expect(tallies.nth(1)).toHaveText('ギルドマスター 1');
    expect(await collect()).toEqual([]);
  });

  test('切り替えで管理者に指名して解除でき、見出しの管理者の数も変わる', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ソラ').getByRole('checkbox', { name: 'ソラをギルドマスターにする' });
    const admins = page.locator('.tally > div').nth(1);
    await expect(admins).toHaveText('ギルドマスター 1');

    await toggle.click();
    await expect(toast(page, 'ソラをギルドマスターに指名しました')).toBeVisible();
    await expect(admins).toHaveText('ギルドマスター 2');
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(toast(page, 'ソラのギルドマスターを解除しました')).toBeVisible();
    await expect(admins).toHaveText('ギルドマスター 1');
    await expect(toggle).not.toBeChecked();

    // 変更の履歴の節に、指名と解除が残る
    const history = page.getByRole('region', { name: '変更の履歴' });
    await page.reload();
    await expect(history.getByText('ソラをギルドマスターに指名しました').first()).toBeVisible();
    await expect(history.getByText('ソラのギルドマスターを解除しました').first()).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('管理者が自分だけなら、自分の切り替えは確認を出さずにその場で断り、何も送らない', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/aoba/user-admin-update', async (route) => {
      requests++;
      await route.continue();
    });
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ミナト').getByRole('checkbox', { name: 'ミナトをギルドマスターにする' });
    await toggle.click();
    await expect(
      toast(page, '最後のギルドマスターは解除も無効にもできません。先にほかの人をギルドマスターに指名してください'),
    ).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toggle).toBeChecked();
    expect(requests).toBe(0);
  });

  test('ほかに管理者がいれば、自分の解除は確認を経る。確認を待つ間、切り替えは今の値のまま', async ({ page }) => {
    await page.goto('/aoba/admin');
    const sora = rowOf(page, 'ソラ').getByRole('checkbox', { name: 'ソラをギルドマスターにする' });
    await sora.click();
    await expect(page.locator('.tally > div').nth(1)).toHaveText('ギルドマスター 2');
    try {
      const toggle = rowOf(page, 'ミナト').getByRole('checkbox', { name: 'ミナトをギルドマスターにする' });
      await toggle.click();
      const dialog = page.getByRole('dialog', { name: '自分のギルドマスターを解除しますか？' });
      await expect(dialog).toContainText('この画面を開けなくなります');
      await expect(toggle).toBeChecked();
      // やめれば何も送らず、切り替えは元のまま
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expect(toggle).toBeChecked();
    } finally {
      await sora.click();
      await expect(page.locator('.tally > div').nth(1)).toHaveText('ギルドマスター 1');
    }
  });

  test('自分の解除が通ったら、組織の枠を読み直して「見つからない」の見出しへフォーカスを移す', async ({ page }) => {
    // ほかの管理者がいる応答と、解除が通った応答に差し替える（seed のミナトは解除しない。ほかのファイルが管理者として使うため）
    await page.route('**/api/aoba/user-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { users: { name: string; is_admin: boolean }[] };
      for (const user of json.users) if (user.name === 'ソラ') user.is_admin = true;
      await route.fulfill({ response, json });
    });
    let revoked = false;
    await page.route('**/api/aoba/user-admin-update', async (route) => {
      const body = route.request().postDataJSON() as { user_id: string };
      revoked = true;
      await route.fulfill({ json: { user_id: body.user_id, is_admin: false, disabled_at: null } });
    });
    await page.route('**/api/aoba/organization', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { me: { is_admin: boolean } };
      if (revoked) json.me.is_admin = false;
      await route.fulfill({ response, json });
    });
    await page.goto('/aoba/admin');
    await rowOf(page, 'ミナト').getByRole('checkbox', { name: 'ミナトをギルドマスターにする' }).click();
    await page
      .getByRole('dialog', { name: '自分のギルドマスターを解除しますか？' })
      .getByRole('button', { name: '解除する' })
      .click();
    await expect(toast(page, 'ミナトのギルドマスターを解除しました')).toBeVisible();
    const heading = page.getByRole('heading', { level: 1, name: '画面が見つかりません' });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
  });

  test('切り替えが 403 で断られたら、組織の枠を読み直し、一覧は読み直さない', async ({ page }) => {
    let lists = 0;
    await page.route('**/api/aoba/user-list', async (route) => {
      lists++;
      await route.continue();
    });
    await page.route('**/api/aoba/user-admin-update', (route) =>
      route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'forbidden' } } }),
    );
    await page.goto('/aoba/admin');
    await expect(rowOf(page, 'ハルカ')).toBeVisible();
    const before = lists;
    // 組織の枠の読み直し（invalidateAll）が返るのを待ち、その後に一覧の読み直しが走らないことを見る
    const reloaded = page.waitForResponse('**/api/aoba/organization');
    await rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカをギルドマスターにする' }).click();
    await expect(toast(page, 'この操作ができるのはギルドマスターだけです。画面を読み直しました')).toBeVisible();
    await reloaded;
    // 読み直しを送るなら、枠の読み直しの直後に送る。少し待って、送られていないことを確かめる
    await page.waitForTimeout(1000);
    expect(lists).toBe(before);
    await expect(
      rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカをギルドマスターにする' }),
    ).not.toBeChecked();
  });

  test('切り替えが 401 で断られたら、ログインへ移り、一覧は読み直さない', async ({ page }) => {
    let lists = 0;
    await page.route('**/api/aoba/user-list', async (route) => {
      lists++;
      await route.continue();
    });
    await page.route('**/api/aoba/user-admin-update', (route) =>
      route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'unauthenticated' } } }),
    );
    await page.goto('/aoba/admin');
    await expect(rowOf(page, 'ハルカ')).toBeVisible();
    const before = lists;
    await rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカをギルドマスターにする' }).click();
    await page.waitForURL(/\/login/);
    expect(lists).toBe(before);
  });

  test('指名が通った後の読み直しが失敗しても、行と見出しの数は応答の値のまま', async ({ page }) => {
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ソラ').getByRole('checkbox', { name: 'ソラをギルドマスターにする' });
    const admins = page.locator('.tally > div').nth(1);
    await expect(admins).toHaveText('ギルドマスター 1');
    await page.route('**/api/aoba/user-list', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'internal' } } }),
    );
    try {
      await toggle.click();
      await expect(toast(page, 'ソラをギルドマスターに指名しました')).toBeVisible();
      await expect(page.getByText('ユーザーの一覧を更新できませんでした')).toBeVisible();
      await expect(admins).toHaveText('ギルドマスター 2');
      await expect(toggle).toBeChecked();
    } finally {
      await page.unroute('**/api/aoba/user-list');
      await toggle.click();
      await expect(toast(page, 'ソラのギルドマスターを解除しました')).toBeVisible();
      await expect(admins).toHaveText('ギルドマスター 1');
    }
  });

  test('確認のダイアログを経て無効にすると、無効の印が付いて切り替えが押せなくなり、有効に戻せる', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/admin');
    const row = rowOf(page, 'ユイ');
    const users = page.locator('.tally > div').nth(0);
    await expect(users).toHaveText('ユーザー 4');
    const disableButton = row.getByRole('button', { name: 'ユイを無効にする' });
    await disableButton.click();

    const dialog = page.getByRole('dialog', { name: 'ユイを無効にしますか？' });
    await expect(dialog).toContainText('すべてのパーティから外れ');
    await expect(dialog).toContainText('有効に戻しても所属とギルドマスターの指名は戻りません');
    await expect(dialog).not.toContainText('{');
    // やめれば何も起きない
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expect(disableButton).toBeFocused();
    await expect(row.locator('.chip')).toHaveCount(0);

    await disableButton.click();
    await dialog.getByRole('button', { name: '無効にする' }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'ユイを無効にしました')).toBeVisible();
    await expect(row.locator('.chip')).toHaveText('無効');
    const disabledToggle = row.getByRole('checkbox', { name: 'ユイをギルドマスターにする' });
    await expect(disabledToggle).toBeDisabled();
    // 押せない理由を、読み上げの説明で結ぶ
    await expect(disabledToggle).toHaveAccessibleDescription('無効の人はギルドマスターに指名できません');
    const enableButton = row.getByRole('button', { name: 'ユイを有効に戻す' });
    await expect(enableButton).toHaveText('有効に戻す');
    await expect(enableButton).toBeFocused();
    // 見出しのユーザーの数は、無効でない人だけを数える
    await expect(users).toHaveText('ユーザー 3');

    // 有効に戻すは確認なしで送る
    await enableButton.click();
    await expect(toast(page, 'ユイを有効に戻しました。入るにはパーティへの招待が要ります')).toBeVisible();
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(row.getByRole('checkbox', { name: 'ユイをギルドマスターにする' })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'ユイを無効にする' })).toBeFocused();
    await expect(users).toHaveText('ユーザー 4');

    const history = page.getByRole('region', { name: '変更の履歴' });
    await page.reload();
    await expect(history.getByText('ユイを無効にしました').first()).toBeVisible();
    await expect(history.getByText('ユイを有効に戻しました').first()).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('409 の理由ごとに知らせ、一覧を読み直す', async ({ page }) => {
    await page.route('**/api/aoba/user-admin-update', (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: 'conflict', message: 'conflict', details: { reason: 'disabled' } } },
      }),
    );
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカをギルドマスターにする' });
    await toggle.click();
    await expect(toast(page, '無効の人はギルドマスターに指名できません。先に有効に戻してください')).toBeVisible();
    await expect(toggle).not.toBeChecked();
  });

  test('人数が上限に達していて指名を断られたら、理由を知らせて切り替えを戻す', async ({ page }) => {
    await page.route('**/api/aoba/user-admin-update', (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: 'conflict', message: 'conflict', details: { reason: 'member_limit' } } },
      }),
    );
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ユイ').getByRole('checkbox', { name: 'ユイをギルドマスターにする' });
    await toggle.click();
    await expect(
      toast(
        page,
        '冒険者ギルドの人数が上限に達しているため、ユイをギルドマスターに指名できません。上限を上げるには運用者に相談してください',
      ),
    ).toBeVisible();
    await expect(toggle).not.toBeChecked();
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('組織の管理の画面は見つからず、ユーザーの一覧は読めない', async ({ page }) => {
    await page.goto('/aoba/admin');
    await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
    await expect(sectionOf(page)).toHaveCount(0);
  });
});
