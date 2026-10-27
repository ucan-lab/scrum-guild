// ワークスペースの作成、組織の管理の画面、ワークスペースの枠。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発の管理者はミナト、一般のユーザーはハルカ。ひばり工房のワークスペースの ID は seed/data.sql の値
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';

// 管理の画面のワークスペースの一覧の行。変更の履歴の節もワークスペースの名前の行を持つので、節で絞る
function workspaceRow(page: Page, name: string) {
  return page.getByRole('region', { name: 'パーティ', exact: true }).locator('tbody tr', { hasText: name });
}

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
    // 見出しにフォーカスを置くのはワークスペースの画面だけ。ほかの画面の見出しは、フォーカスを受けない
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveAttribute('tabindex', /.*/);
    // 表の見出しは数だと分かる短い形。名前の列には最小幅を持たせる（ユーザーの節の表が先に並ぶので、ワークスペースの表で絞る）
    const table = page.getByRole('table', { name: 'パーティの一覧' });
    await expect(table.locator('thead th').nth(1)).toHaveText('冒険者数');
    await expect(table.locator('thead th').nth(2)).toHaveText('パーティリーダー数');
    expect(await table.locator('th.is-name').evaluate((th) => getComputedStyle(th).minWidth)).not.toBe('auto');

    const row = workspaceRow(page, '受託開発チーム');
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
    // 見出しは画面の名前（掲示板）で、小見出しがワークスペースの名前
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('保守チーム');
    // 移った先の見出しにフォーカスが移る
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeFocused();
    // 所属しているので、所属していない印は出ない。メニューにワークスペースの節が出る
    await expect(page.getByText(/所属せず/)).toHaveCount(0);
    await expect(page.locator('.ws-select')).toContainText('保守チーム');
    // 画面のある項目だけを出すので、ワークスペースの節と、メンバーを持つ管理の節
    await expect(page.locator('.nav-group')).toHaveText(['パーティ', '管理']);
    // 画面にも起票のダイアログ（中に閉じた読み上げの領域がある）があるので、見える領域だけを role で引く
    await expect(page.getByRole('status').filter({ hasText: 'パーティを作りました' })).toBeVisible();
    expect(await collect()).toEqual([]);

    // 一覧に出て、リーダーが1人のメンバーが1人
    await page.goto('/aoba/admin');
    const row = workspaceRow(page, '保守チーム');
    await expect(row.locator('td').nth(1)).toHaveText('1');
    await expect(row.locator('td').nth(2)).toHaveText('1');
  });

  test('別の人をリーダーにスクラムの言葉で作ると、中の言葉づかいがスクラムになり、所属していない印が出る', async ({
    page,
  }) => {
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    // 題とラベルと説明文は、選んだ言葉づかいの言葉に替わる（題が替わるので、名前では探さない）
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await expect(dialog.getByLabel('最初のパーティリーダー')).toBeVisible();
    await dialog.getByRole('radio', { name: /スクラムの言葉/ }).check();
    await expect(page.getByRole('dialog', { name: 'ワークスペースを作る' })).toBeVisible();
    await expect(dialog.getByLabel('最初のリーダー')).toBeVisible();
    // 説明文が、選んだ言葉づかいの名前に替わる
    await expect(dialog.getByText(/列は「未着手、作業中、レビュー、完了」/)).toBeVisible();
    await expect(dialog.getByText(/決まった欄は「受け入れ基準」/)).toBeVisible();
    await expect(dialog.getByText(/1 ポイント = 4 時間/)).toBeVisible();
    await dialog.getByLabel('名前').fill('社内ツール改善');
    await dialog.getByRole('combobox').selectOption({ label: 'ハルカ' });
    await dialog.getByRole('button', { name: '作る' }).click();

    await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('社内ツール改善');
    // ワークスペースの中の言葉はスクラム。組織の言葉（ギルドマスター）はそのまま
    await expect(page.locator('.nav-group')).toHaveText(['ワークスペース', '管理']);
    await expect(page.getByText('まだタスクがありません')).toBeVisible();
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

    // 直し始めたら、知らせを消す
    await dialog.getByLabel('名前').fill('保守チーム');
    await expect(dialog.getByRole('alert')).toHaveCount(0);

    // 見えない文字（ゼロ幅のスペース）は、サーバーも断る
    await dialog.getByLabel('名前').fill('保守\u{200B}チーム');
    await dialog.getByRole('button', { name: '作る' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      '名前に使えない文字（制御文字、ゼロ幅のスペースなど）が含まれています',
    );
    expect(requests).toBe(0);
  });

  test('送っている間は、「作る」を押しても無視し、ダイアログも閉じられず、状態を読み上げに伝え、1回しか送らない', async ({
    page,
  }) => {
    let requests = 0;
    await page.route('**/api/aoba/workspace-create', async (route) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await dialog.getByLabel('名前').fill('二重送信の確認');
    await dialog.getByRole('button', { name: '作る' }).click();

    // disabled でなく aria-disabled。押しても何も起きない
    const submitting = dialog.getByRole('button', { name: '作っています' });
    await expect(submitting).toHaveAttribute('aria-disabled', 'true');
    await expect(submitting).not.toHaveAttribute('disabled');
    await expect(dialog.getByRole('status')).toHaveText('作っています');
    // aria-disabled のボタンは、Playwright が押せないものとして待つので、force で押す
    await submitting.click({ force: true });
    await submitting.click({ force: true });

    // やめる、×、Esc、背景のどれでも閉じない
    await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '閉じる' }).click({ force: true });
    await expect(dialog).toBeVisible();
    // Esc は何回押しても閉じない（Chromium は、1回止めた後の Esc を止められない形で閉じるので、開き直している）
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
    }
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    // 欄は変えられず、読み上げの領域は form の外にある
    await expect(dialog.getByLabel('名前')).toBeDisabled();
    await expect(dialog.getByLabel('最初のパーティリーダー')).toBeDisabled();
    await expect(dialog.getByRole('radio', { name: /スクラムの言葉/ })).toBeDisabled();
    await expect(dialog.locator('form [role="status"]')).toHaveCount(0);

    await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
    expect(requests).toBe(1);
  });

  test('送っている間に別の画面へ移ったら、古い応答では移り直さない', async ({ page }) => {
    await page.route('**/api/aoba/workspace-create', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.goto('/aoba');
    await page.locator('.nav-item', { hasText: '組織の管理' }).click();
    await expect(page).toHaveURL(/\/aoba\/admin$/);
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await dialog.getByLabel('名前').fill('離れた後の応答');
    await dialog.getByRole('button', { name: '作る' }).click();
    await expect(dialog.getByRole('status')).toHaveText('作っています');

    // 部品が外れる移動（戻る）。ダイアログは閉じられなくても、ブラウザの戻るは効く
    await page.goBack();
    await page.waitForTimeout(1800);
    await expect(page).not.toHaveURL(/\/aoba\/w\//);
  });

  test('候補を読み込めないときは知らせ、「もう一度試す」は読み直している間も残り、直ったら作れる', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/aoba/workspace-leader-candidates', async (route) => {
      calls++;
      if (calls === 1) return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } });
      await new Promise((resolve) => setTimeout(resolve, 600));
      return route.continue();
    });
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('alert')).toHaveText('選べる人を読み込めませんでした');
    // 選ぶ欄は常に置き、ラベルがその欄を指す
    await expect(dialog.getByLabel('最初のパーティリーダー')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '作る' })).toHaveAttribute('aria-disabled', 'true');

    const retry = dialog.getByRole('button', { name: 'もう一度試す' });
    await retry.click();
    // 読み直している間も、ボタンは残り、押せない。欄は読み込み中の表示になる
    const retrying = dialog.getByRole('button', { name: '読み込んでいます' });
    await expect(retrying).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByLabel('最初のパーティリーダー')).toHaveAttribute('aria-busy', 'true');
    await expect(dialog.getByRole('status')).toHaveText('読み込んでいます');

    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await expect(dialog.getByRole('button', { name: '作る' })).toHaveAttribute('aria-disabled', 'false');
    await expect(dialog.getByRole('button', { name: 'もう一度試す' })).toHaveCount(0);
    // 押したボタンが消えるので、選ぶ欄へフォーカスが移る
    await expect(dialog.getByRole('combobox')).toBeFocused();
  });

  test('候補を読み込めないときの欄は、理由の文を二重に出さない', async ({ page }) => {
    await page.route('**/api/aoba/workspace-leader-candidates', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('alert')).toHaveText('選べる人を読み込めませんでした');
    await expect(dialog.getByRole('combobox').locator('option')).toHaveText(['—']);
    await expect(dialog.getByText('選べる人を読み込めませんでした')).toHaveCount(1);
  });

  test('作れたのに組織の枠の読み直しが失敗しても、作ったワークスペースの画面へ移る', async ({ page }) => {
    let created = false;
    await page.route('**/api/aoba/workspace-create', async (route) => {
      await route.continue();
      created = true;
    });
    // 作った後の組織の枠の読み直しだけを失敗させる
    await page.route('**/api/aoba/organization', (route) =>
      created ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }) : route.continue(),
    );
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await dialog.getByLabel('名前').fill('読み直しに失敗');
    await dialog.getByRole('button', { name: '作る' }).click();

    await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: '読み込めませんでした' })).toBeVisible();
  });

  test('選んだ最初のリーダーが指せなくなっていて 404 になったら、選び直しを促し、候補を取り直す', async ({ page }) => {
    let candidateCalls = 0;
    await page.route('**/api/aoba/workspace-leader-candidates', (route) => {
      candidateCalls++;
      return route.continue();
    });
    await page.route('**/api/aoba/workspace-create', (route) =>
      route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'x' } } }),
    );
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    expect(candidateCalls).toBe(1);
    await dialog.getByLabel('名前').fill('選び直し');
    await dialog.getByRole('button', { name: '作る' }).click();

    await expect(dialog.getByText('選び直してください')).toBeVisible();
    await expect.poll(() => candidateCalls).toBe(2);
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    // 作れなかったので、移らず、また送れる
    await expect(page).toHaveURL(/\/aoba\/admin$/);
    await expect(dialog.getByRole('button', { name: '作る' })).toHaveAttribute('aria-disabled', 'false');
  });

  test('ブラウザのタイムゾーンが断られたら、直せない理由を伝える', async ({ page }) => {
    await page.route('**/api/aoba/workspace-create', (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'invalid_input',
            message: 'x',
            details: [{ path: 'timezone', code: 'custom', message: 'x' }],
          },
        },
      }),
    );
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    await dialog.getByLabel('名前').fill('タイムゾーン');
    await dialog.getByRole('button', { name: '作る' }).click();
    await expect(dialog.getByText('このブラウザのタイムゾーン（Asia/Tokyo）では作れません')).toBeVisible();
  });

  test('組織の管理の一覧を読むときにセッションが切れていたら（401）、今のパスを return_to に入れてログインへ移す', async ({
    page,
  }) => {
    await page.route('**/api/aoba/workspace-list', (route) =>
      route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'x' } } }),
    );
    await page.goto('/aoba/admin');
    await expect(page).toHaveURL(/\/login\?return_to=%2Faoba%2Fadmin$/);
  });

  test('サーバーが名前を断ったら、送り終えて欄が戻った後に、名前の欄へフォーカスを戻す', async ({ page }) => {
    await page.route('**/api/aoba/workspace-create', (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'invalid_input',
            message: 'x',
            details: [{ path: 'name', code: 'custom', message: 'x' }],
          },
        },
      }),
    );
    await page.goto('/aoba/admin');
    await page.getByRole('button', { name: 'パーティを作る' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'パーティを作る' });
    await expect(dialog.getByRole('combobox')).toBeEnabled();
    const nameField = dialog.getByLabel('名前');
    await nameField.fill('断られる名前');
    await dialog.getByRole('button', { name: '作る' }).click();
    await expect(nameField).toBeEnabled();
    await expect(nameField).toBeFocused();
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

  test('入れないワークスペース（403）は、「もう一度試す」を出さず、入れない案内と自分の今日へ戻るリンクを出す', async ({
    page,
  }) => {
    await page.route('**/api/aoba/workspace', (route) =>
      route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'x' } } }),
    );
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
    await expect(page.getByRole('heading', { level: 1, name: 'パーティが見つかりません' })).toBeVisible();
    await expect(page.getByText('URL が違うか、入れないパーティです。')).toBeVisible();
    await expect(page.getByRole('button', { name: 'もう一度試す' })).toHaveCount(0);
    await page.getByRole('link', { name: '自分の今日へ' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
  });

  test('ワークスペースの言葉づかいは、最初の描画から当たる', async ({ page }) => {
    await page.route('**/api/aoba/workspace', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { vocabulary: string };
      body.vocabulary = 'scrum';
      await route.fulfill({ response, json: body });
    });
    // 描画のたびに、ワークスペースの節の見出しの文字を集める。ゲームの言葉（パーティ）が一度も出ない
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __groupTexts: string[] }).__groupTexts = seen;
      new MutationObserver(() => {
        for (const group of document.querySelectorAll('.nav-group')) seen.push(group.textContent ?? '');
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('受託開発チーム');
    const seen = await page.evaluate(() => (window as unknown as { __groupTexts: string[] }).__groupTexts);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('パーティ');
    expect(seen).toContain('ワークスペース');
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
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('受託開発チーム');
    await expect(page.getByText(/所属せず/)).toHaveCount(0);
    await expect(page.locator('.ws-select')).toContainText('受託開発チーム');
  });
});
