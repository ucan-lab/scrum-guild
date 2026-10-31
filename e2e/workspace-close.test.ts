// ワークスペースを終了する、再開する。管理者が終了する（確認のダイアログを経る）→ 帯を確かめる → 再開する。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。
// 終了して確かめるワークスペースは、管理の画面から作った専用のもの（seed のワークスペースを終了したままにしない）。
// 作ったワークスペースは消せずに残るので、名前に繰り返し（--repeat-each）とやり直しの回を混ぜ、前の回の行に当たらないようにする
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { expectFocusReturned, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const BANNER = /\d{4}-\d{2}-\d{2} に終了しました。読み取り専用です。/;

// 終了した帯。ストーリーのダイアログも終了したワークスペースの案内に .callout を持ち、開く前から DOM にあるので、帯の文で絞る
function bannerOf(page: Page) {
  return page.locator('.callout', { hasText: 'に終了しました。読み取り専用です。' });
}

// 管理の画面のワークスペースの節。変更の履歴の節も表を持ち、ワークスペースの名前の行が出るので、節で絞る
function workspacesOf(page: Page) {
  return page.getByRole('region', { name: 'パーティ', exact: true });
}

// この回の印。作る行の名前に混ぜる
function runMark(): string {
  return `${test.info().repeatEachIndex}-${test.info().retry}`;
}

// 管理の画面から、自分をリーダーにワークスペースを作る。作ると、そのワークスペースの画面へ移る
async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto('/aoba/admin');
  await page.getByRole('button', { name: 'パーティを作る' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByLabel('名前').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
  return page.url();
}

test.describe('管理者（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('確認のダイアログを経て終了し、帯と読み取り専用を確かめ、再開すると元に戻る', async ({ page }) => {
    const collect = await watchViolations(page);
    const name = `終了確認パーティ ${runMark()}`;
    const workspaceUrl = await createWorkspace(page, name);
    // 進行中のうちは帯が無く、起票できる
    await expect(bannerOf(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '依頼を出す' })).toBeVisible();

    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });
    const closeButton = row.getByRole('button', { name: `「${name}」を終了する` });
    await expect(closeButton).toHaveText('終了する');
    await closeButton.click();

    // 確認のダイアログ。読み取り専用になることと、再開できることを書く。危険の色にはしない
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    await expect(dialog).toContainText('読み取り専用');
    await expect(dialog).toContainText('いつでも再開できます');
    // 本文は言葉づかいに依らない（対象のワークスペースの名前だけを埋める）
    await expect(dialog).not.toContainText('{');
    await expect(dialog.locator('.is-danger')).toHaveCount(0);
    // やめれば何も起きない
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, closeButton);
    await expect(row.locator('.chip')).toHaveCount(0);

    await closeButton.click();
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'パーティを終了しました' })).toBeVisible();
    // 一覧を読み直して、終了の印と「再開する」に替わる。押したボタンは残り、フォーカスを保つ
    await expect(row.locator('.chip')).toHaveText(/^終了 \d{4}-\d{2}-\d{2}$/);
    const reopenButton = row.getByRole('button', { name: `「${name}」を再開する` });
    await expect(reopenButton).toHaveText('再開する');
    await expect(reopenButton).toBeFocused();
    // 見出しの集計は進行中のワークスペースの数
    await expect(page.locator('.tally')).toContainText('進行中のパーティ');

    // 終了したワークスペースの画面: どの画面にも帯が出て、起票の操作は出ない。管理者には組織の管理へのリンクが付く
    await page.goto(workspaceUrl);
    const banner = bannerOf(page);
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText(BANNER);
    // リンクは本文と同じ色（既定のリンクの青にしない）で、下線を引く
    const link = banner.getByRole('link', { name: '組織の管理で再開する' });
    const colors = await banner.evaluate((el) => [
      getComputedStyle(el.querySelector('a')!).color,
      getComputedStyle(el.querySelector('span')!).color,
    ]);
    expect(colors[0]).toBe(colors[1]);
    await expect(link).toHaveCSS('text-decoration-line', 'underline');
    await expect(banner.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '依頼を出す' })).toHaveCount(0);
    // 見出しの右上の「終了 <日>」の印は、帯と重なるので出さない
    await expect(page.locator('.page-head .chip')).toHaveCount(0);
    await banner.getByRole('link', { name: '組織の管理で再開する' }).click();
    await expect(page).toHaveURL(/\/aoba\/admin$/);

    // 再開する。確認なしで送り、一覧が読み直される
    await row.getByRole('button', { name: `「${name}」を再開する` }).click();
    await expect(page.getByRole('status').filter({ hasText: 'パーティを再開しました' })).toBeVisible();
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(row.getByRole('button', { name: `「${name}」を終了する` })).toHaveText('終了する');

    await page.goto(workspaceUrl);
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(bannerOf(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '依頼を出す' })).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('送っている間は、「終了する」を押しても無視し、ダイアログも閉じられず、1回しか送らない', async ({ page }) => {
    const name = `二重送信の確認パーティ ${runMark()}`;
    await createWorkspace(page, name);
    let requests = 0;
    await page.route('**/api/aoba/workspace-close', async (route) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });
    await row.getByRole('button', { name: `「${name}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();

    // disabled でなく aria-disabled。押しても何も起きない
    const submitting = dialog.getByRole('button', { name: '終了しています' });
    await expect(submitting).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('status')).toHaveText('終了しています');
    await submitting.click({ force: true });
    await submitting.click({ force: true });
    await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    await expect(dialog).toBeHidden();
    await expect(row.locator('.chip')).toHaveText(/^終了 /);
    expect(requests).toBe(1);

    // 後片づけ。再開しておく
    await row.getByRole('button', { name: `「${name}」を再開する` }).click();
    await expect(row.locator('.chip')).toHaveCount(0);
  });

  test('終了できなかったときは、ダイアログの中に理由を出して開いたままにする。別の画面で先に終了されていたら、読み直して知らせる', async ({
    page,
  }) => {
    const name = `失敗の確認パーティ ${runMark()}`;
    await createWorkspace(page, name);
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });

    await page.route('**/api/aoba/workspace-close', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await row.getByRole('button', { name: `「${name}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    await expect(dialog.getByRole('alert')).toHaveText('パーティを終了できませんでした。もう一度試してください。');
    await expect(dialog.getByRole('button', { name: `「${name}」を終了する` })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await expect(row.locator('.chip')).toHaveCount(0);

    // 別の画面で先に終了されていた（409）
    await page.unroute('**/api/aoba/workspace-close');
    await page.route('**/api/aoba/workspace-close', async (route) => {
      await page.request.post('/api/aoba/workspace-close', {
        headers: { Origin: new URL(page.url()).origin },
        data: JSON.parse(route.request().postData() ?? '{}'),
      });
      await route.continue();
    });
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    // 終了し直されたのか、再開されたのかは言い切らない
    await expect(page.getByRole('status').filter({ hasText: `「${name}」の状態が変わっていました` })).toBeVisible();
    await expect(row.locator('.chip')).toHaveText(/^終了 /);

    await page.unroute('**/api/aoba/workspace-close');
    await row.getByRole('button', { name: `「${name}」を再開する` }).click();
    await expect(row.locator('.chip')).toHaveCount(0);
  });

  // 受託開発チームを、一覧の上だけで終了した状態にする（seed のワークスペースを終了しない）。操作は route で差し替える
  const SEED_NAME = '受託開発チーム';
  async function showSeedWorkspaceClosed(page: Page, onList: (call: number) => 'real' | 'fail') {
    let calls = 0;
    await page.route('**/api/aoba/workspace-list', async (route) => {
      calls++;
      if (onList(calls) === 'fail') {
        return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } });
      }
      const response = await route.fetch();
      const body = (await response.json()) as { workspaces: { name: string; closed_at: string | null }[] };
      for (const workspace of body.workspaces) {
        if (workspace.name === SEED_NAME) workspace.closed_at = '2026-10-22T00:00:00.000Z';
      }
      return route.fulfill({ response, json: body });
    });
    return () => calls;
  }

  test('390px の幅では、行を縦に積み、操作は横にはみ出さずに見える', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/aoba/admin');
    const button = page
      .locator('tbody tr', { hasText: SEED_NAME })
      .getByRole('button', { name: `「${SEED_NAME}」を終了する` });
    await expect(button).toBeAttached();
    // 760px 以下は列をやめて積むので、表は横にはみ出さず、操作の列を固定する必要が無い（#462）
    const overflow = await workspacesOf(page)
      .locator('.table-wrap')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // 縦には、その行まで動かす。横には動かさずに見える
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    // 押す所は 44px 以上
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });

  test('空白の無い長い名前でも、確認の見出しとトーストは折り返してはみ出さない', async ({ page }) => {
    // 名前の上限（50字）いっぱいに、空白を入れずに回の印を末尾に付ける
    const mark = runMark().replace('-', 'x');
    const name = `${'W'.repeat(50 - mark.length)}${mark}`;
    await createWorkspace(page, name);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.route('**/api/aoba/workspace-close', (route) =>
      route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'x' } } }),
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: name });
    await row.getByRole('button', { name: `「${name}」を終了する` }).scrollIntoViewIfNeeded();
    await row.getByRole('button', { name: `「${name}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${name}」を終了しますか？` });
    const overflow = (selector: string) => dialog.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(await overflow('.dialog-title')).toBeLessThanOrEqual(0);
    expect(await overflow('.dialog-sheet')).toBeLessThanOrEqual(0);

    // 404 のトースト（名前入り）も、はみ出さない
    await dialog.getByRole('button', { name: `「${name}」を終了する` }).click();
    const toast = page.getByRole('status').filter({ hasText: `「${name}」を操作できませんでした` });
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await toast.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
  });

  test('終了の確認で 404 を受けたら、理由を出してダイアログを閉じ、一覧を読み直す', async ({ page }) => {
    await page.route('**/api/aoba/workspace-close', (route) =>
      route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'x' } } }),
    );
    let listCalls = 0;
    await page.route('**/api/aoba/workspace-list', (route) => {
      listCalls++;
      return route.continue();
    });
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();
    const dialog = page.getByRole('dialog', { name: `「${SEED_NAME}」を終了しますか？` });
    await dialog.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: `「${SEED_NAME}」を操作できませんでした` })).toBeVisible();
    await expect.poll(() => listCalls).toBe(2);
  });

  test('再開が 409 の conflict になったら、状態が変わっていたことを知らせて読み直す', async ({ page }) => {
    const listCalls = await showSeedWorkspaceClosed(page, () => 'real');
    await page.route('**/api/aoba/workspace-reopen', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x' } } }),
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    // 「すでに開いています」とは言い切らない（終了し直された場合もある）
    await expect(
      page.getByRole('status').filter({ hasText: `「${SEED_NAME}」の状態が変わっていました` }),
    ).toBeVisible();
    await expect(page.getByText('すでに開いています')).toHaveCount(0);
    await expect.poll(listCalls).toBe(2);
  });

  // 人数の上限で断られた理由は、4秒で消えるトーストでなく、表の上の消えないコールアウトに出す
  function refusalOf(page: Page) {
    return workspacesOf(page).locator('.callout.is-warn[role="alert"]', {
      hasText: `「${SEED_NAME}」は再開できません`,
    });
  }

  test('再開が 409 の member_limit_reached になったら、増える人数と今の人数、上限、対処を表の上に残して読み直す', async ({
    page,
  }) => {
    const listCalls = await showSeedWorkspaceClosed(page, () => 'real');
    await page.route('**/api/aoba/workspace-reopen', (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: 'member_limit_reached', message: 'x', details: { used: 14, limit: 15, adding: 2 } } },
      }),
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    const refusal = refusalOf(page);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('承諾待ちの招待の 2 人が冒険者ギルドの人数に加わり');
    await expect(refusal).toContainText('今の 14 人と合わせて上限の 15 人を超えます');
    // 対処は、上限の見直し（運用者に問い合わせる）と、ほかのユーザーを無効にすることだけ。閉じたパーティの招待は取り消せない
    await expect(refusal).toContainText('上限の見直しは運用者に問い合わせてください');
    await expect(refusal).toContainText('組織の管理の「ユーザー」で、ほかのユーザーを無効にして人数を減らしてください');
    await expect(refusal).toContainText('有効に戻しても所属は戻りません');
    await expect(refusal).not.toContainText('取り消');
    await expect(refusal).not.toContainText('{');
    // 表の上にある。汎用の失敗の文言には落とさない
    const aboveTable = await refusal.evaluate(
      (el) =>
        (el.compareDocumentPosition(el.parentElement!.querySelector('table')!) & Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    );
    expect(aboveTable).toBe(true);
    await expect(page.getByText('を再開できませんでした')).toHaveCount(0);
    // 一覧を読み直した後も、トーストが消える時間を過ぎても残る
    await expect.poll(listCalls).toBe(2);
    await page.waitForTimeout(5000);
    await expect(refusal).toBeVisible();

    // 次に「再開する」を押すと消える（成功すれば、そのままトーストで知らせる）
    await page.unroute('**/api/aoba/workspace-reopen');
    await page.route('**/api/aoba/workspace-reopen', (route) =>
      route.fulfill({ json: { workspace_id: '019a0000-0000-7000-8000-000000000401' } }),
    );
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();
    await expect(refusal).toHaveCount(0);
  });

  test('details の無い 409 の member_limit_reached は、数なしの理由を同じ場所に残して読み直す', async ({ page }) => {
    const listCalls = await showSeedWorkspaceClosed(page, () => 'real');
    await page.route('**/api/aoba/workspace-reopen', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'member_limit_reached', message: 'x' } } }),
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    const refusal = refusalOf(page);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('承諾待ちの招待を含めると、冒険者ギルドの人数が上限を超えます');
    await expect(refusal).toContainText('上限の見直しは運用者に問い合わせてください');
    await expect(refusal).toContainText('ほかのユーザーを無効にして人数を減らしてください');
    // 数の穴を残さない。汎用の失敗の文言にも落とさない
    for (const leaked of ['人が', '{', 'undefined', 'NaN']) await expect(refusal).not.toContainText(leaked);
    await expect(page.getByText('を再開できませんでした')).toHaveCount(0);
    await expect.poll(listCalls).toBe(2);
    await expect(refusal).toBeVisible();
  });

  test('空白の無い長い名前でも、断った理由は折り返してはみ出さず、画面の中に入る', async ({ page }) => {
    // 名前の上限（50字）いっぱいに、空白を入れない
    const longName = 'W'.repeat(50);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.route('**/api/aoba/workspace-list', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { workspaces: { name: string; closed_at: string | null }[] };
      for (const workspace of body.workspaces) {
        if (workspace.name === SEED_NAME)
          Object.assign(workspace, { name: longName, closed_at: '2026-10-22T00:00:00.000Z' });
      }
      return route.fulfill({ response, json: body });
    });
    await page.route('**/api/aoba/workspace-reopen', (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: 'member_limit_reached', message: 'x', details: { used: 14, limit: 15, adding: 2 } } },
      }),
    );
    await page.goto('/aoba/admin');
    const button = workspacesOf(page)
      .locator('tbody tr', { hasText: longName })
      .getByRole('button', { name: `「${longName}」を再開する` });
    await button.scrollIntoViewIfNeeded();
    await button.click();

    const refusal = workspacesOf(page).locator('.callout.is-warn[role="alert"]', {
      hasText: `「${longName}」は再開できません`,
    });
    await expect(refusal).toBeVisible();
    expect(await refusal.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await refusal.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
    // 押した行が下にあっても、理由が画面の中に入る
    await expect(refusal).toBeInViewport();
  });

  test('操作の後の読み直しに失敗したら、一覧を残したまま知らせ、「もう一度試す」で読み直せる', async ({ page }) => {
    // 2回目（操作の後の読み直し）だけ失敗させる
    await showSeedWorkspaceClosed(page, (call) => (call === 2 ? 'fail' : 'real'));
    await page.route('**/api/aoba/workspace-reopen', (route) =>
      route.fulfill({ json: { workspace_id: '019a0000-0000-7000-8000-000000000401' } }),
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    await row.getByRole('button', { name: `「${SEED_NAME}」を再開する` }).click();

    const notice = page.locator('.callout', { hasText: 'パーティの一覧を更新できませんでした' });
    await expect(notice.getByRole('alert')).toHaveText('パーティの一覧を更新できませんでした');
    // 知らせ（alert）と状態（status）は入れ子にしない
    await expect(notice.locator('[role="alert"] [role="status"]')).toHaveCount(0);
    // 今の一覧は残る
    await expect(row).toBeVisible();
    await notice.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(notice).toHaveCount(0);
    await expect(row).toBeVisible();
    // 押したボタンが消えるので、節の中身へフォーカスが移る
    await expect(workspacesOf(page).locator('.setting-body[tabindex="-1"]')).toBeFocused();
  });

  test('「もう一度試す」を押していない読み込みの結果では、「まだ読み込めませんでした」を出さない', async ({ page }) => {
    // 2、3、5 回目を失敗させる: 操作の後の読み直しが失敗 → 「もう一度試す」も失敗 → 別の操作の読み直しが成功 → また別の操作の読み直しが失敗
    await showSeedWorkspaceClosed(page, (call) => ([2, 3, 5].includes(call) ? 'fail' : 'real'));
    await page.route('**/api/aoba/workspace-reopen', (route) =>
      route.fulfill({ json: { workspace_id: '019a0000-0000-7000-8000-000000000401' } }),
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    const reopen = row.getByRole('button', { name: `「${SEED_NAME}」を再開する` });
    const notice = page.locator('.callout', { hasText: 'パーティの一覧を更新できませんでした' });

    await reopen.click();
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(notice.getByRole('status')).toHaveText('まだ読み込めませんでした');

    // 押していない読み込み（操作の後の読み直し）が成功すると、知らせごと消える
    await reopen.click();
    await expect(notice).toHaveCount(0);
    // その次の読み直しが失敗しても、押していないので「まだ」とは出ない
    await reopen.click();
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('status')).toHaveText('');
  });

  test('先に始めた読み直しが後で返っても、新しい一覧を古い一覧で上書きしない', async ({ page }) => {
    // 2回目（1回目の操作の後の読み直し）は遅らせ、古い一覧（終了した）を返す。3回目（2回目の操作の後）は本物の一覧（進行中）を先に返す
    let calls = 0;
    let staleDone: () => void = () => {};
    const staleSent = new Promise<void>((resolve) => (staleDone = resolve));
    await page.route('**/api/aoba/workspace-list', async (route) => {
      calls++;
      if (calls !== 2) return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { workspaces: { name: string; closed_at: string | null }[] };
      for (const workspace of body.workspaces) {
        if (workspace.name === SEED_NAME) workspace.closed_at = '2026-10-22T00:00:00.000Z';
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.fulfill({ response, json: body });
      staleDone();
    });
    await page.route('**/api/aoba/workspace-close', (route) =>
      route.fulfill({
        json: { workspace_id: '019a0000-0000-7000-8000-000000000401', closed_at: '2026-10-26T00:00:00.000Z' },
      }),
    );
    await page.goto('/aoba/admin');
    const row = workspacesOf(page).locator('tbody tr', { hasText: SEED_NAME });
    const close = row.getByRole('button', { name: `「${SEED_NAME}」を終了する` });
    const dialog = page.getByRole('dialog', { name: `「${SEED_NAME}」を終了しますか？` });

    // 1回目の終了する: 読み直し（2回目）が遅れている間に、2回目の終了する（読み直しは3回目）を済ませる
    await close.click();
    await dialog.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    await close.click();
    await dialog.getByRole('button', { name: `「${SEED_NAME}」を終了する` }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => calls).toBe(3);

    // 遅れた古い一覧が返った後も、新しい一覧（進行中）のまま
    await staleSent;
    await page.waitForTimeout(300);
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(close).toBeVisible();
  });

  test('一覧を読み込めないときは節の中に知らせ、「もう一度試す」で読み直せる。ほかの部分は出る', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/aoba/workspace-list', (route) => {
      calls++;
      if (calls === 1) return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } });
      return route.continue();
    });
    await page.goto('/aoba/admin');
    // 見出しと節の見出しは出ている
    await expect(page.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();
    // 「パーティの外の言葉づかい」の節と分けるため、名前は完全に一致させる
    await expect(page.getByRole('heading', { level: 2, name: 'パーティ', exact: true })).toBeVisible();
    await expect(page.getByText('パーティの一覧を読み込めませんでした')).toBeVisible();
    await expect(page.getByRole('button', { name: 'パーティを作る' })).toBeVisible();

    await page.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(workspacesOf(page).locator('tbody tr', { hasText: '受託開発チーム' })).toBeVisible();
    await expect(page.getByText('パーティの一覧を読み込めませんでした')).toHaveCount(0);
  });

  test('初回の読み込み中は、空の読み上げの領域を先に描き、後から文字を入れる', async ({ page }) => {
    // 節の読み上げの領域（data-section-status）が DOM に入ったときと、中の文字が変わったときを順に記録する。
    // 領域と文字が同じ描画で入ると読み上げられないことがあるので、空の領域が先で、文字が後であることを見る
    await page.addInitScript(() => {
      const log: string[] = [];
      (window as unknown as { __sectionStatusLog: string[] }).__sectionStatusLog = log;
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          // 領域は節ごとまとめて DOM に入るので、足された要素の中も探す
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            const added = node.matches('[data-section-status]')
              ? [node]
              : node.querySelectorAll('[data-section-status]');
            for (const region of added) log.push(`added:${region.textContent}`);
          }
          const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
          const region = target?.closest('[data-section-status]');
          if (region) log.push(`text:${region.textContent}`);
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.route('**/api/aoba/workspace-list', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await page.goto('/aoba/admin', { waitUntil: 'commit' });
    // ワークスペースの節の領域（ほかの節も同じ領域を持つ）
    const region = page.getByRole('region', { name: 'パーティ', exact: true }).locator('[data-section-status]');
    await expect(region).toHaveText('読み込んでいます');
    const log = await page.evaluate(() => (window as unknown as { __sectionStatusLog: string[] }).__sectionStatusLog);
    expect(log[0]).toBe('added:');
    expect(log.indexOf('text:読み込んでいます')).toBeGreaterThan(0);
    // 読めたら、領域は残したまま文字を消す
    await expect(workspacesOf(page).locator('tbody tr', { hasText: '受託開発チーム' })).toBeVisible();
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText('');
  });

  test('狭い幅でも、節の「もう一度試す」は押せる範囲が 44px 四方以上ある', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.route('**/api/aoba/workspace-list', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await page.goto('/aoba/admin');
    const retry = page.getByRole('button', { name: 'もう一度試す' });
    await expect(retry).toBeVisible();
    // 見た目の大きさは変えず、::after で押せる範囲だけを広げる（横のヒントの文字を上にずらさないため）
    const hit = await retry.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return { width: parseFloat(after.width), height: parseFloat(after.height), position: after.position };
    });
    expect(hit.position).toBe('absolute');
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    expect((await retry.boundingBox())!.height).toBeLessThan(44);
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('終了したワークスペースの帯は出るが、組織の管理へのリンクは出ない', async ({ page }) => {
    // 受託開発チームを、画面の上だけで終了した状態にする（seed のワークスペースを終了しない）
    await page.route('**/api/aoba/workspace', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { closed_at: string | null };
      body.closed_at = '2026-10-22T00:00:00.000Z';
      await route.fulfill({ response, json: body });
    });
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(bannerOf(page)).toHaveText(BANNER);
    await expect(bannerOf(page).getByRole('link')).toHaveCount(0);
  });
});
