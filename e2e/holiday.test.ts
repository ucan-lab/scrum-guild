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
    // 欄に結ぶのは要約（読み上げの領域）で、行ごとの一覧はその領域の外に置く
    const describedBy = (await paste.getAttribute('aria-describedby')) ?? '';
    const summary = section.locator(`[id="${describedBy.split(' ')[0]!}"]`);
    await expect(summary).toHaveAttribute('role', 'alert');
    await expect(summary).toHaveText('1 行を登録しません。直して、もう一度「登録する」を押してください。');
    await expect(summary.getByRole('list')).toHaveCount(0);

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
    await expect(page.getByRole('status').filter({ hasText: '2027-02-11（建国記念の日）を消しました' })).toBeVisible();
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

  test('登録できる行が上限の 100 を超えたら送らず、分けて登録するよう出す', async ({ page }) => {
    let addCalls = 0;
    await page.route('**/api/aoba/organization-holiday-add', (route) => {
      addCalls++;
      return route.continue();
    });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const lines = Array.from({ length: 101 }, (_, i) => new Date(Date.UTC(2031, 0, 1 + i)).toISOString().slice(0, 10));
    const paste = section.getByLabel('貼り付けて登録');
    await paste.fill(lines.join('\n'));
    await section.getByRole('button', { name: '登録する' }).click();
    await expect(section.getByRole('alert')).toHaveText(
      '登録できる行が 101 日あります。1回に登録できるのは 100 日までです。分けて登録してください。',
    );
    await expect(paste).toHaveAttribute('aria-invalid', 'true');
    expect(addCalls).toBe(0);
  });

  test('理由の一覧は 10 行までで、残りは「ほか n 行」にまとめ、長い行は切って出す', async ({ page }) => {
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const long = `x${'あ'.repeat(50)}`;
    const lines = [long, ...Array.from({ length: 11 }, (_, i) => `1999-01-${String(i + 1).padStart(2, '0')}`)];
    await section.getByLabel('貼り付けて登録').fill(lines.join('\n'));
    await section.getByRole('button', { name: '登録する' }).click();
    const items = section.getByRole('list', { name: '登録しない行' }).getByRole('listitem');
    await expect(items).toHaveCount(11);
    await expect(items.first()).toHaveText(
      `1 行目「${long.slice(0, 40)}…」: 日付の形ではありません（2026-11-03 か 2026/11/3）`,
    );
    await expect(items.nth(1)).toHaveText('2 行目「1999-01-01」: 2000〜2099 年の日付だけを登録できます');
    await expect(items.last()).toHaveText('ほか 2 行');
    await expect(section.getByRole('alert')).toHaveText(
      '12 行を登録しません。直して、もう一度「登録する」を押してください。',
    );
  });

  test('消すときに、別の画面で先に消されていた（404）なら、見つからなかったと知らせて読み直す', async ({ page }) => {
    await page.route('**/api/aoba/organization-holiday-delete', (route) =>
      route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'x' } } }),
    );
    let listCalls = 0;
    await page.route('**/api/aoba/organization-holiday-list', (route) => {
      listCalls++;
      return route.continue();
    });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    await section.getByRole('button', { name: '2026-11-23 を消す' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '2026-11-23 は見つかりませんでした。一覧を確かめてください' }),
    ).toBeVisible();
    await expect.poll(() => listCalls).toBe(2);
    // 実際には消していないので、行は残る
    await expect(section.getByRole('list', { name: '登録した休日' })).toContainText('2026-11-23');
  });

  test('消す応答を待つ間に貼り付けの欄へ移っていたら、応答の後もフォーカスを欄に残す', async ({ page }) => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    // seed の行を消さないよう、応答は 404 に差し替える（フォーカスを移す処理は成功と同じ道を通る）
    await page.route('**/api/aoba/organization-holiday-delete', async (route) => {
      await released;
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'x' } } });
    });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    await section.getByRole('button', { name: '2026-11-23 を消す' }).click();
    const paste = section.getByLabel('貼り付けて登録');
    await paste.focus();
    release();
    await expect(page.getByRole('status').filter({ hasText: '2026-11-23 は見つかりませんでした' })).toBeVisible();
    await expect(section.getByRole('button', { name: '2026-11-23 を消す' })).toBeEnabled();
    await expect(paste).toBeFocused();
  });

  test('送っている間は欄を readonly にし、送れた後に残す行は押した時点の内容から作る', async ({ page }) => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/aoba/organization-holiday-add', async (route) => {
      await released;
      await route.fulfill({ json: { added: 1, skipped: 0 } });
    });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const paste = section.getByLabel('貼り付けて登録');
    await paste.fill('2027-03-01 創立記念日\n2027-02-30 無い日');
    await section.getByRole('button', { name: '登録する' }).click();
    await expect(paste).toHaveAttribute('readonly', '');
    // readonly を越えて欄が書き換わっても（スクリプトなど）、残す行は押した時点の解析の結果から作る
    await paste.evaluate((el: HTMLTextAreaElement) => {
      el.value += '\n2027-13-01 打ち足した行';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    release();
    await expect(page.getByRole('status').filter({ hasText: '1 日を登録しました' })).toBeVisible();
    await expect(paste).toHaveValue('2027-02-30 無い日');
    await expect(paste).not.toHaveAttribute('readonly');
  });

  test('320px の幅でも、節は横にはみ出さず、削除のボタンは右端に見える', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const button = section.getByRole('button', { name: '2026-11-03 を消す' });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    // 狭い幅では、指で押す画面でなくても押せる範囲を 44px 四方にする
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });

  test('320px の幅で空白の無い40字の名前でも、日付は1行のまま折れない', async ({ page }) => {
    await page.route('**/api/aoba/organization-holiday-list', (route) =>
      route.fulfill({
        json: { holidays: [{ holiday_on: '2027-11-03', name: 'SoukyuKaihatsuKyokaiSouritsuKinenbiKyuj' }] },
      }),
    );
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/aoba/admin');
    const item = sectionOf(page).getByRole('list', { name: '登録した休日' }).getByRole('listitem').first();
    const date = item.locator('.mono');
    await expect(date).toHaveText('2027-11-03');
    // 2行に折れれば、高さは文字の大きさの2倍を超える
    const ratio = await date.evaluate(
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).fontSize),
    );
    expect(ratio).toBeLessThan(2);
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
