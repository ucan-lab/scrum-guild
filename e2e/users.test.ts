// 組織の管理の画面の「ユーザー」の節。管理者が一覧を見て、管理者に指名して解除し、無効にして有効に戻す。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。
// 書き換えるのは、このファイルだけが使う所属の無いソラ（指名と解除）とユイ（無効化と有効化）だけで、どちらもテストの中で元に戻す
// （seed/data.sql。ソラは承諾待ちの招待と同じログインなので、管理者にしても組織の人数は変わらない）。
// ファイルの中のテストは順に走る（集計の数を見るため）
import type { Page } from '@playwright/test';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { userEnable, userList } from '../src/shared/operations/organization/user.ts';
import { expect, test } from './fixtures.ts';
import { expectFocusReturned, signIn, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, rewriteOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

function sectionOf(page: Page) {
  return page.getByRole('region', { name: 'ユーザー', exact: true });
}

function rowOf(page: Page, name: string) {
  return sectionOf(page).getByRole('table', { name: '組織のユーザーの一覧' }).locator('tbody tr', { hasText: name });
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
    // 一覧の API が返した値を手元に取る（応答は変えない）
    let listed: OutputOf<typeof userList> | undefined;
    await rewriteOperation(page, userList, { slug: 'aoba' }, (output) => (listed = output));
    await page.goto('/aoba/admin');
    const table = sectionOf(page).getByRole('table', { name: '組織のユーザーの一覧' });
    await expect(table.getByRole('columnheader')).toHaveText(['名前', '管理者', '所属', '最後に入った日', '操作']);
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
    await expect(me.getByRole('checkbox', { name: 'ミナトを管理者にする' })).toBeChecked();
    // 自分の行には「無効にする」を出さない
    await expect(me.getByRole('button')).toHaveCount(0);
    const haruka = rowOf(page, 'ハルカ');
    await expect(haruka.getByRole('checkbox', { name: 'ハルカを管理者にする' })).not.toBeChecked();
    // 所属の数は API の値。ハルカは seed では 1 だが、ほかのファイル（e2e/workspace.test.ts）がハルカをリーダーにワークスペースを作り、
    // 消せずに残るので、並べて走る順と繰り返し（--repeat-each）で増える。所属の無いソラは、このファイルしか触らないので 0 のまま
    const harukaCount = listed?.users.find((user) => user.name === 'ハルカ')?.workspace_count;
    expect(harukaCount).toBeGreaterThanOrEqual(1);
    await expect(haruka.locator('td.is-num')).toHaveText(String(harukaCount));
    await expect(rowOf(page, 'ソラ').locator('td.is-num')).toHaveText('0');
    await expect(haruka.getByRole('button', { name: 'ハルカを無効にする' })).toHaveText('無効にする');
    // 最後に入った日は、ブラウザのタイムゾーン（東京）の日付。入ったことの無い人は「—」
    await expect(rowOf(page, 'ソラ').locator('td.mono')).toHaveText('2026-10-12');
    // 「—」は読み上げに渡さず、見えない文字で「まだ入っていません」を添える
    await expect(rowOf(page, 'ユイ').locator('td.mono [aria-hidden="true"]')).toHaveText('—');
    await expect(rowOf(page, 'ユイ').locator('td.mono .visually-hidden')).toHaveText('まだ入っていません');

    const tallies = page.locator('.tally > div');
    await expect(tallies.nth(0)).toHaveText('ユーザー 4');
    await expect(tallies.nth(1)).toHaveText('管理者 1');
    expect(await collect()).toEqual([]);
  });

  test('切り替えで管理者に指名して解除でき、見出しの管理者の数も変わる', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ソラ').getByRole('checkbox', { name: 'ソラを管理者にする' });
    const admins = page.locator('.tally > div').nth(1);
    await expect(admins).toHaveText('管理者 1');

    await toggle.click();
    await expect(toast(page, 'ソラを管理者に指名しました')).toBeVisible();
    await expect(admins).toHaveText('管理者 2');
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(toast(page, 'ソラの管理者を解除しました')).toBeVisible();
    await expect(admins).toHaveText('管理者 1');
    await expect(toggle).not.toBeChecked();

    // 変更の履歴の節に、指名と解除が残る
    const history = page.getByRole('region', { name: '変更の履歴' });
    await page.reload();
    await expect(history.getByText('ソラを管理者に指名しました').first()).toBeVisible();
    await expect(history.getByText('ソラの管理者を解除しました').first()).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('管理者が自分だけなら、自分の切り替えは確認を出さずにその場で断り、何も送らない', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/aoba/user-admin-update', async (route) => {
      requests++;
      await route.continue();
    });
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ミナト').getByRole('checkbox', { name: 'ミナトを管理者にする' });
    await toggle.click();
    await expect(
      toast(page, '最後の管理者は解除も無効にもできません。先にほかの人を管理者に指名してください'),
    ).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toggle).toBeChecked();
    expect(requests).toBe(0);
  });

  test('ほかに管理者がいれば、自分の解除は確認を経る。確認を待つ間、切り替えは今の値のまま', async ({ page }) => {
    await page.goto('/aoba/admin');
    const sora = rowOf(page, 'ソラ').getByRole('checkbox', { name: 'ソラを管理者にする' });
    await sora.click();
    await expect(page.locator('.tally > div').nth(1)).toHaveText('管理者 2');
    try {
      const toggle = rowOf(page, 'ミナト').getByRole('checkbox', { name: 'ミナトを管理者にする' });
      await toggle.click();
      const dialog = page.getByRole('dialog', { name: '自分の管理者を解除しますか？' });
      await expect(dialog).toContainText('この画面を開けなくなります');
      await expect(toggle).toBeChecked();
      // やめれば何も送らず、切り替えは元のまま
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expect(toggle).toBeChecked();
    } finally {
      await sora.click();
      await expect(page.locator('.tally > div').nth(1)).toHaveText('管理者 1');
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
    await rowOf(page, 'ミナト').getByRole('checkbox', { name: 'ミナトを管理者にする' }).click();
    await page
      .getByRole('dialog', { name: '自分の管理者を解除しますか？' })
      .getByRole('button', { name: '解除する' })
      .click();
    await expect(toast(page, 'ミナトの管理者を解除しました')).toBeVisible();
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
    await rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカを管理者にする' }).click();
    await expect(toast(page, 'この操作ができるのは管理者だけです。画面を読み直しました')).toBeVisible();
    await reloaded;
    // 読み直しを送るなら、枠の読み直しの直後に送る。少し待って、送られていないことを確かめる
    await page.waitForTimeout(1000);
    expect(lists).toBe(before);
    await expect(rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカを管理者にする' })).not.toBeChecked();
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
    await rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカを管理者にする' }).click();
    await page.waitForURL(/\/login/);
    expect(lists).toBe(before);
  });

  test('指名が通った後の読み直しが失敗しても、行と見出しの数は応答の値のまま', async ({ page }) => {
    await page.goto('/aoba/admin');
    const toggle = rowOf(page, 'ソラ').getByRole('checkbox', { name: 'ソラを管理者にする' });
    const admins = page.locator('.tally > div').nth(1);
    await expect(admins).toHaveText('管理者 1');
    await page.route('**/api/aoba/user-list', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'internal' } } }),
    );
    try {
      await toggle.click();
      await expect(toast(page, 'ソラを管理者に指名しました')).toBeVisible();
      await expect(page.getByText('ユーザーの一覧を更新できませんでした')).toBeVisible();
      await expect(admins).toHaveText('管理者 2');
      await expect(toggle).toBeChecked();
    } finally {
      await page.unroute('**/api/aoba/user-list');
      await toggle.click();
      await expect(toast(page, 'ソラの管理者を解除しました')).toBeVisible();
      await expect(admins).toHaveText('管理者 1');
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
    await expect(dialog).toContainText('すべてのワークスペースから外れ');
    await expect(dialog).toContainText('有効に戻しても所属と管理者の指名は戻りません');
    await expect(dialog).not.toContainText('{');
    // やめれば何も起きない
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, disableButton);
    await expect(row.locator('.chip')).toHaveCount(0);

    await disableButton.click();
    await dialog.getByRole('button', { name: '無効にする' }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'ユイを無効にしました')).toBeVisible();
    await expect(row.locator('.chip')).toHaveText('無効');
    const disabledToggle = row.getByRole('checkbox', { name: 'ユイを管理者にする' });
    await expect(disabledToggle).toBeDisabled();
    // 押せない理由を、読み上げの説明で結ぶ
    await expect(disabledToggle).toHaveAccessibleDescription('無効の人は管理者に指名できません');
    const enableButton = row.getByRole('button', { name: 'ユイを有効に戻す' });
    await expect(enableButton).toHaveText('有効に戻す');
    await expect(enableButton).toBeFocused();
    // 見出しのユーザーの数は、無効でない人だけを数える
    await expect(users).toHaveText('ユーザー 3');

    // 有効に戻すは確認なしで送る
    await enableButton.click();
    await expect(toast(page, 'ユイを有効に戻しました。入るにはワークスペースへの招待が要ります')).toBeVisible();
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(row.getByRole('checkbox', { name: 'ユイを管理者にする' })).toBeEnabled();
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
    const toggle = rowOf(page, 'ハルカ').getByRole('checkbox', { name: 'ハルカを管理者にする' });
    await toggle.click();
    await expect(toast(page, '無効の人は管理者に指名できません。先に有効に戻してください')).toBeVisible();
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
    const toggle = rowOf(page, 'ユイ').getByRole('checkbox', { name: 'ユイを管理者にする' });
    await toggle.click();
    await expect(
      toast(
        page,
        '組織の人数が上限に達しているため、ユイを管理者に指名できません。上限を上げるには運用者に相談してください',
      ),
    ).toBeVisible();
    await expect(toggle).not.toBeChecked();
  });

  // ユイを、一覧の上だけで無効の人にする（seed のユイを無効にしたままにしない）。有効に戻す操作は route で差し替える
  async function showYuiDisabled(page: Page) {
    await rewriteOperation(page, userList, { slug: 'aoba' }, (output) => ({
      users: output.users.map((user) =>
        user.name === 'ユイ' ? { ...user, disabled_at: '2026-10-22T00:00:00.000Z' } : user,
      ),
    }));
  }

  // 人数の上限で断られた理由は、4秒で消えるトーストでなく、表の上の消えないコールアウトに出す
  function refusalOf(page: Page) {
    return sectionOf(page).locator('.callout.is-warn[role="alert"]', { hasText: 'ユイを有効に戻せません' });
  }

  test('有効に戻すが 409 の member_limit_reached になったら、増える人数と今の人数、上限、対処を表の上に残して読み直す', async ({
    page,
  }) => {
    await showYuiDisabled(page);
    let lists = 0;
    await page.route('**/api/aoba/user-list', async (route) => {
      lists++;
      await route.fallback();
    });
    const unroute = await failOperation(page, userEnable, { slug: 'aoba' }, 409, 'member_limit_reached', {
      details: { used: 15, limit: 15, adding: 1 },
    });
    await page.goto('/aoba/admin');
    const button = rowOf(page, 'ユイ').getByRole('button', { name: 'ユイを有効に戻す' });
    await button.click();

    const refusal = refusalOf(page);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('承諾待ちの招待の 1 人が組織の人数に加わり');
    await expect(refusal).toContainText('今の 15 人と合わせて上限の 15 人を超えます');
    // 対処は、上限の見直し（運用者に問い合わせる）と、ほかのユーザーを無効にすること、リーダーに招待を取り消してもらうこと
    await expect(refusal).toContainText('上限の見直しは運用者に問い合わせてください');
    await expect(refusal).toContainText('ほかのユーザーを無効にして人数を減らす');
    await expect(refusal).toContainText('リーダーにユイへの承諾待ちの招待を取り消してもらってください');
    await expect(refusal).not.toContainText('{');
    // 表の上にある。汎用の失敗の文言には落とさない
    const aboveTable = await refusal.evaluate(
      (el) =>
        (el.compareDocumentPosition(el.parentElement!.querySelector('table')!) & Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    );
    expect(aboveTable).toBe(true);
    await expect(page.getByText('を変更できませんでした')).toHaveCount(0);
    // 無効のまま、押したボタンにフォーカスが残る。一覧を読み直した後も、トーストが消える時間を過ぎても残る
    await expect.poll(() => lists).toBe(2);
    await expect(rowOf(page, 'ユイ').locator('.chip')).toHaveText('無効');
    await expect(button).toBeFocused();
    await page.waitForTimeout(5000);
    await expect(refusal).toBeVisible();

    // 次に「有効に戻す」を押すと消える（成功すれば、そのままトーストで知らせる）
    await unroute();
    await mockOperation(page, userEnable, { slug: 'aoba' }, { user_id: 'ignored', is_admin: false, disabled_at: null });
    // 成功の後の一覧の読み直しが途中のままテストを終えると、差し替えの route が切れた応答を読んで落ちるので、応答まで待つ
    const reread = page.waitForResponse('**/api/aoba/user-list');
    await button.click();
    await expect(toast(page, 'ユイを有効に戻しました')).toBeVisible();
    await expect(refusal).toHaveCount(0);
    await reread;
  });

  test('details の無い 409 の member_limit_reached は、数なしの理由を同じ場所に残して読み直す', async ({ page }) => {
    await showYuiDisabled(page);
    await failOperation(page, userEnable, { slug: 'aoba' }, 409, 'member_limit_reached');
    await page.goto('/aoba/admin');
    await rowOf(page, 'ユイ').getByRole('button', { name: 'ユイを有効に戻す' }).click();

    const refusal = refusalOf(page);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('承諾待ちの招待を含めると、組織の人数が上限を超えます');
    await expect(refusal).toContainText('上限の見直しは運用者に問い合わせてください');
    // 数の穴を残さない。汎用の失敗の文言にも落とさない
    for (const leaked of ['人が', '{', 'undefined', 'NaN']) await expect(refusal).not.toContainText(leaked);
    await expect(page.getByText('を変更できませんでした')).toHaveCount(0);
    await expect(rowOf(page, 'ユイ').locator('.chip')).toHaveText('無効');
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
