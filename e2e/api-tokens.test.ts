// 自分の設定（/<slug>/me）の「API トークン」の節（#581）。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発の管理者のミナトで、発行 → 値が1回だけ見える → 一覧に出る（値は出ない）→ そのトークンで API を呼ぶ → 取り消す → 一覧から消える、
// を通す。作ったトークンは、各テストの中で取り消して残さない。ミナトには seed のトークン（seed/api-tokens.ts）もあるので、行は名前で絞る。
// 有効なトークンの上限（20件）は test/api-token-settings-fixes.test.ts が確かめ、ここは上限で断られたときの画面の知らせだけを見る
import type { Page } from '@playwright/test';
import { tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { word } from '../src/shared/vocabulary.ts';
import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled, watchViolations } from './helpers.ts';
import { failOperation, mockOperation } from './operations.ts';

const TOKEN_PATTERN = /^sgp_[A-Za-z0-9_-]{43}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 並べて走る別のテストと名前が重ならないようにする
const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const sectionOf = (page: Page) => page.getByRole('region', { name: 'API トークン', exact: true });
const rowOf = (page: Page, name: string) =>
  sectionOf(page).getByRole('table', { name: '発行済みの API トークン' }).locator('tbody tr', { hasText: name });
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

async function issue(page: Page, name: string, scope: '読み取り' | '書き込み', days: string): Promise<string> {
  const section = sectionOf(page);
  await section.getByLabel('名前', { exact: true }).fill(name);
  await section.getByRole('radio', { name: scope }).check();
  await section.getByLabel('有効日数').fill(days);
  await section.getByRole('button', { name: '発行する' }).click();
  const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
  await expect(dialog).toBeVisible();
  return dialog.getByLabel('トークンの値').inputValue();
}

async function closeIssued(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
  await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toHaveCount(0);
}

// 取り消しの確認のダイアログを経て、取り消す
async function revoke(page: Page, name: string): Promise<void> {
  await rowOf(page, name)
    .getByRole('button', { name: `API トークン「${name}」を取り消す` })
    .click();
  const confirm = page.getByRole('dialog', { name: `API トークン「${name}」を取り消しますか` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(confirm).toHaveCount(0);
}

test('発行すると値が1回だけ見え、一覧に出て（値は出ない）、そのトークンで API を呼べ、取り消すと一覧から消えて使えなくなる', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const collect = await watchViolations(page);
  const name = uniqueName('手元の CLI');
  await page.goto('/aoba/me');
  const section = sectionOf(page);
  await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  await expect(rowOf(page, name)).toHaveCount(0);

  // 発行。値は発行の直後のダイアログにだけ出る。開いた直後のフォーカスは値の欄でなく、知らせの前の本文
  const token = await issue(page, name, '書き込み', '30');
  expect(token).toMatch(TOKEN_PATTERN);
  const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
  await expect(dialog.getByText(`「${name}」の値です。`)).toBeFocused();
  await expect(
    dialog.getByText('この値は二度と見られません。閉じる前にコピーして、安全な場所に保管してください。'),
  ).toBeVisible();
  await expect(dialog.getByLabel('トークンの値')).toHaveAttribute('readonly', '');

  // コピー
  await dialog.getByRole('button', { name: 'コピーする' }).click();
  await expect(toast(page, 'トークンの値をコピーしました')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  // 閉じると値は画面のどこにも残らず、フォーカスは発行の欄へ戻る。発行の欄は空に戻る
  await closeIssued(page);
  await expect(section.getByLabel('名前', { exact: true })).toBeFocused();
  await expect(section.getByLabel('名前', { exact: true })).toHaveValue('');
  await expect(section.getByRole('radio', { name: '読み取り' })).toBeChecked();
  await expect(section.getByLabel('有効日数')).toHaveValue('90');
  expect(
    await page
      .locator('input')
      .evaluateAll((inputs, value) => inputs.some((input) => (input as HTMLInputElement).value === value), token),
  ).toBe(false);
  expect(await page.locator('body').innerText()).not.toContain(token);

  // 一覧。名前、範囲、期限、最後に使った日（未使用）。値は出ない
  const row = rowOf(page, name);
  await expect(row).toHaveCount(1);
  await expect(row.locator('td[data-label="範囲"]')).toHaveText('書き込み');
  await expect(row.locator('td[data-label="期限"]')).toHaveText(DATE_PATTERN);
  await expect(row.locator('td[data-label="最後に使った日"]')).toHaveText('未使用');
  await expect(row).not.toContainText('sgp_');

  // そのトークンで API を呼べる（Cookie でなく Authorization だけで）
  const call = () =>
    page.request.post('/api/me', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {},
    });
  expect((await call()).status()).toBe(200);
  // 使うと、一覧の最後に使った日が日付になる
  await page.reload();
  await expect(rowOf(page, name).locator('td[data-label="最後に使った日"]')).toHaveText(DATE_PATTERN);

  // 取り消し。確認のダイアログでやめると行は残り、フォーカスは押したボタンへ戻る。取り消せない旨を書く
  const revokeButton = rowOf(page, name).getByRole('button', { name: `API トークン「${name}」を取り消す` });
  await revokeButton.click();
  const confirm = page.getByRole('dialog', { name: `API トークン「${name}」を取り消しますか` });
  await expect(confirm.getByText('取り消すと、このトークンはすぐ使えなくなります。元に戻せません。')).toBeVisible();
  await confirm.getByRole('button', { name: 'やめる' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(revokeButton).toBeFocused();
  await expect(rowOf(page, name)).toHaveCount(1);
  expect((await call()).status()).toBe(200);

  await revoke(page, name);
  // 知らせは数秒で消えるので、行が消える確認より先に見る
  await expect(toast(page, `「${name}」を取り消しました`)).toBeVisible();
  await expect(rowOf(page, name)).toHaveCount(0);
  await expect(section.getByLabel('名前', { exact: true })).toBeFocused();
  expect((await call()).status()).toBe(401);
  // 開き直しても出ない
  await page.reload();
  await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  await expect(rowOf(page, name)).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('入力の誤りは送る前に欄の下へ出し、その欄へフォーカスを移す（送らない）', async ({ page }) => {
  let created = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/token-create')) created++;
  });
  await page.goto('/aoba/me');
  const section = sectionOf(page);
  const name = section.getByLabel('名前', { exact: true });
  const days = section.getByLabel('有効日数');
  await waitForSettled(page);

  await section.getByRole('button', { name: '発行する' }).click();
  await expect(section.getByRole('alert')).toHaveText('名前を入力してください');
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');

  // 空白だけも同じ。入力し始めると誤りは消える
  await name.fill('   ');
  await section.getByRole('button', { name: '発行する' }).click();
  await expect(section.getByRole('alert')).toHaveText('名前を入力してください');
  await name.fill('a'.repeat(101));
  await section.getByRole('button', { name: '発行する' }).click();
  await expect(section.getByRole('alert')).toHaveText('名前は100文字までです');
  await name.fill('確かめ用');
  await expect(section.getByRole('alert')).toHaveCount(0);

  for (const value of ['0', '91', '1.5', '']) {
    await days.fill(value);
    await section.getByRole('button', { name: '発行する' }).click();
    await expect(section.getByRole('alert')).toHaveText('有効日数は1〜90の整数で入力してください');
    await expect(days).toBeFocused();
    await expect(days).toHaveAttribute('aria-invalid', 'true');
  }
  expect(created).toBe(0);
});

test('発行に失敗したら、入力を残したまま理由を出し、値のダイアログは開かない。取り消しに失敗したら行を残して知らせる', async ({
  page,
}) => {
  const section = sectionOf(page);
  const name = uniqueName('失敗の確かめ');
  await page.goto('/aoba/me');
  await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();

  const unrouteCreate = await failOperation(page, tokenCreate, 500, 'internal');
  await section.getByLabel('名前', { exact: true }).fill(name);
  await section.getByRole('button', { name: '発行する' }).click();
  await expect(section.getByRole('alert')).toHaveText('発行できませんでした。時間をおいて、もう一度試してください');
  await expect(section.getByLabel('名前', { exact: true })).toHaveValue(name);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await unrouteCreate();

  // 本物の応答に戻して発行し直せる
  await section.getByRole('button', { name: '発行する' }).click();
  await expect(page.getByRole('dialog', { name: 'API トークンを発行しました' })).toBeVisible();
  await closeIssued(page);
  await expect(rowOf(page, name)).toHaveCount(1);

  const unrouteRevoke = await failOperation(page, tokenRevoke, 500, 'internal');
  await revoke(page, name);
  await expect(toast(page, '取り消せませんでした。時間をおいて、もう一度試してください')).toBeVisible();
  await expect(rowOf(page, name)).toHaveCount(1);
  await unrouteRevoke();

  await revoke(page, name);
  await expect(rowOf(page, name)).toHaveCount(0);
});

test('一覧が空なら空の状態を出し、読めなければこの節にだけ失敗と「もう一度試す」を出す（ほかの節は生かす）', async ({
  page,
}) => {
  const section = sectionOf(page);
  const unrouteEmpty = await mockOperation(page, tokenList, { tokens: [], can_create: true });
  await page.goto('/aoba/me');
  await expect(section.getByText('発行済みの API トークンはありません')).toBeVisible();
  await expect(section.getByText('上のフォームで発行すると、ここに並びます。')).toBeVisible();
  await expect(section.getByRole('table')).toHaveCount(0);
  await unrouteEmpty();

  const failing = await failOperation(page, tokenList, 500, 'internal');
  await page.goto('/aoba/me');
  await expect(section.getByText('API トークンを読み込めませんでした')).toBeVisible();
  // ほかの節（経験値の明細）は生きている
  await expect(page.getByRole('heading', { level: 2, name: '経験値の明細' })).toBeVisible();
  await expect(page.getByText('経験値の明細を読み込めませんでした')).toHaveCount(0);
  await failing();

  await section.getByRole('button', { name: 'もう一度試す（API トークン）' }).click();
  await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  await expect(section.getByText('API トークンを読み込めませんでした')).toHaveCount(0);
  // 押したボタンが消えるので、節の題へフォーカスを移し、読めたことを読み上げの領域で伝える
  await expect(section.getByRole('heading', { level: 2, name: 'API トークン' })).toBeFocused();
  await expect(section.getByRole('status').filter({ hasText: 'API トークンの一覧を読み込みました' })).toHaveCount(1);
});

test('発行直後のダイアログは、Esc を押しても背景を押しても閉じず、値が残り、「閉じる」で閉じる', async ({ page }) => {
  const name = uniqueName('閉じない');
  await page.goto('/aoba/me');
  await expect(sectionOf(page).getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  const token = await issue(page, name, '読み取り', '1');
  const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
  const value = dialog.getByLabel('トークンの値');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(value).toHaveValue(token);
  // 続けてもう一度押しても残る（ブラウザは止めた後の2回目の Esc で閉じることがあるので、Dialog が開き直す）
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(value).toHaveValue(token);

  // 背景（画面の左上の隅。ダイアログの外側）を押す
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await expect(value).toHaveValue(token);

  // × でも閉じられる
  await dialog.getByRole('button', { name: '閉じる', exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
  await revoke(page, name);
  await expect(rowOf(page, name)).toHaveCount(0);
});

test('名前は絵文字51個（102単位）と半角100文字でも、有効日数は1でも、発行できる', async ({ page }) => {
  await page.goto('/aoba/me');
  await expect(sectionOf(page).getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  for (const name of ['😀'.repeat(51), 'a'.repeat(100)]) {
    expect(await issue(page, name, '読み取り', '1')).toMatch(TOKEN_PATTERN);
    await closeIssued(page);
    await expect(rowOf(page, name)).toHaveCount(1);
    await revoke(page, name);
    await expect(rowOf(page, name)).toHaveCount(0);
  }
});

test('有効なトークンが上限に達していたら、断られた理由と取り消しの促しを出し、値のダイアログは開かない', async ({
  page,
}) => {
  const section = sectionOf(page);
  await page.goto('/aoba/me');
  await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  // 取り消す行。上限の知らせは取り消しを促すので、取り消せたら消える
  const spare = uniqueName('上限の確かめ用');
  await issue(page, spare, '読み取り', '7');
  await closeIssued(page);
  const unroute = await failOperation(page, tokenCreate, 409, 'conflict', { details: { reason: 'limit' } });
  await section.getByLabel('名前', { exact: true }).fill('上限の確かめ');
  await section.getByRole('button', { name: '発行する' }).click();
  await expect(section.getByRole('alert')).toHaveText(
    '発行できるトークンは20件までです。使わないものを取り消してください',
  );
  await expect(section.getByLabel('名前', { exact: true })).toHaveValue('上限の確かめ');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await revoke(page, spare);
  await expect(section.getByRole('alert')).toHaveCount(0);
  await unroute();
});

{
  test('節の文言が言葉の辞書のスクラムの言葉で出る', async ({ page }) => {
    const w = word;
    await page.goto('/aoba/me');
    await waitForSettled(page);
    await expect(page.locator('.org-menu-label')).toHaveText(w('organization'));
    const section = page.getByRole('region', { name: w('apiTokenTitle'), exact: true });
    await expect(section.getByRole('heading', { level: 2, name: w('apiTokenTitle') })).toBeVisible();
    await expect(section.getByText(w('apiTokenDesc'))).toBeVisible();
    await expect(section.getByLabel(w('apiTokenNameLabel'), { exact: true })).toBeVisible();
    await expect(section.getByRole('radio', { name: w('apiTokenScopeRead') })).toBeVisible();
    await expect(section.getByRole('radio', { name: w('apiTokenScopeWrite') })).toBeVisible();
    await expect(section.getByText(w('apiTokenScopeHint'))).toBeVisible();
    await expect(section.getByLabel(w('apiTokenLifetimeLabel'))).toBeVisible();
    await expect(section.getByRole('button', { name: w('apiTokenCreate') })).toBeVisible();
    const table = section.getByRole('table', { name: w('apiTokenListLabel') });
    await expect(table.locator('thead th')).toHaveText([
      w('apiTokenNameLabel'),
      w('apiTokenScopeLabel'),
      w('apiTokenHeaderExpires'),
      w('apiTokenHeaderLastUsed'),
      w('apiTokenActionsHeader'),
    ]);
    await expect(page.getByText(w('meOtherSettingsNote'))).toBeVisible();

    // 発行した直後のダイアログと、取り消しの確認も同じ辞書の文言で出す
    const name = uniqueName('辞書');
    await section.getByLabel(w('apiTokenNameLabel'), { exact: true }).fill(name);
    await section.getByRole('button', { name: w('apiTokenCreate') }).click();
    const issued = page.getByRole('dialog', { name: w('apiTokenIssuedTitle') });
    await expect(issued).toBeVisible();
    await expect(issued.getByText(w('apiTokenOnce'))).toBeVisible();
    await expect(issued.getByRole('button', { name: w('apiTokenCopy') })).toBeVisible();
    await issued
      .locator('.dialog-foot')
      .getByRole('button', { name: w('close') })
      .click();
    await expect(issued).toHaveCount(0);

    const row = table.locator('tbody tr', { hasText: name });
    await expect(row.locator('td').nth(3)).toHaveText(w('apiTokenNeverUsed'));
    await row.getByRole('button', { name: w('apiTokenRevokeLabel', { name }) }).click();
    const confirm = page.getByRole('dialog', { name: w('apiTokenRevokeTitle', { name }) });
    await expect(confirm.getByText(w('apiTokenRevokeText'))).toBeVisible();
    await confirm.getByRole('button', { name: w('apiTokenRevoke'), exact: true }).click();
    await expect(row).toHaveCount(0);
  });
}

// 5列の表は、横の面と並ぶ本文（.layout-main）に入れると PC の幅で押しつぶされるので、経験値の明細と同じく .layout-aside の下に全幅で置く
for (const width of [1100, 1280, 1440]) {
  test(`${width}px の幅では、API トークンの節が本文の幅より広く出て、表が横にはみ出さず、「取り消す」が同じ行の別のセルに重ならない`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // 区切りの無い長めの名前で、名前の列が広がっても取り消すボタンが押しつぶされないことも見る
    const name = uniqueName('長い名前の確かめ'.repeat(5));
    await page.goto('/aoba/me');
    await expect(sectionOf(page).getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
    await issue(page, name, '読み取り', '7');
    await closeIssued(page);
    await expect(rowOf(page, name)).toHaveCount(1);

    const measured = await page.evaluate((rowName) => {
      const table = document.querySelector('table[aria-label="発行済みの API トークン"]')!;
      const wrap = table.closest('.table-wrap')!;
      const section = table.closest('.section')!;
      const main = document.querySelector('.layout-main')!;
      const row = [...table.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(rowName))!;
      const button = row.querySelector('td.is-actions button')!.getBoundingClientRect();
      const overlaps = [...row.querySelectorAll('td:not(.is-actions)')].map((td) => {
        const box = td.getBoundingClientRect();
        return button.left < box.right && button.right > box.left && button.top < box.bottom && button.bottom > box.top;
      });
      return {
        overflow: wrap.scrollWidth - wrap.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        sectionWidth: section.getBoundingClientRect().width,
        // .setting（見出しの列 260px）に入れていないこと
        inSetting: table.closest('.setting') !== null,
        mainWidth: main.getBoundingClientRect().width,
        buttonRight: button.right,
        buttonWidth: button.width,
        overlaps,
      };
    }, name);
    expect(measured.overflow).toBeLessThanOrEqual(0);
    expect(measured.pageOverflow).toBeLessThanOrEqual(0);
    // 本文（.layout-main）の中でなく、その外の全幅に置かれている
    expect(measured.sectionWidth).toBeGreaterThan(measured.mainWidth);
    expect(measured.inSetting).toBe(false);
    expect(measured.buttonRight).toBeLessThanOrEqual(width);
    expect(measured.buttonWidth).toBeGreaterThan(0);
    expect(measured.overlaps.length).toBeGreaterThan(0);
    expect(measured.overlaps.every((overlap) => !overlap)).toBe(true);

    await revoke(page, name);
    await expect(rowOf(page, name)).toHaveCount(0);
  });
}

test('390px の幅でも、発行と取り消しができ、画面が横にはみ出さず、操作は 44px 四方以上', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = uniqueName('スマホ');
  await page.goto('/aoba/me');
  const section = sectionOf(page);
  await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  const submit = section.getByRole('button', { name: '発行する' });
  await submit.scrollIntoViewIfNeeded();
  const size = async (locator: ReturnType<typeof section.getByRole>) => {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    return box!;
  };
  expect((await size(submit)).height).toBeGreaterThanOrEqual(44);
  // 範囲の選択肢は区切りのボタン（.segmented）で、デザインシステムの部品の高さ（41px）のまま使う。44px の保証があるのはボタンだけ
  for (const radio of ['読み取り', '書き込み']) await expect(section.getByRole('radio', { name: radio })).toBeVisible();

  const token = await issue(page, name, '読み取り', '7');
  expect(token).toMatch(TOKEN_PATTERN);
  // 長い値も、ダイアログの中で横にはみ出さない（値の欄は横へ送れる）
  expect(await overflow()).toBeLessThanOrEqual(0);
  const sheet = await size(page.locator('.dialog-sheet', { hasText: 'API トークンを発行しました' }));
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(390);
  await closeIssued(page);

  // 行は縦に積まれ、各行の見出し（data-label）が値の前に出る。取り消すボタンは 44px 四方以上
  const row = rowOf(page, name);
  await expect(row).toHaveCount(1);
  await expect(row.locator('td[data-label="範囲"]')).toHaveText('読み取り');
  const revokeButton = row.getByRole('button', { name: `API トークン「${name}」を取り消す` });
  await revokeButton.scrollIntoViewIfNeeded();
  const revokeBox = await size(revokeButton);
  expect(revokeBox.width).toBeGreaterThanOrEqual(44);
  expect(revokeBox.height).toBeGreaterThanOrEqual(44);
  expect(revokeBox.x + revokeBox.width).toBeLessThanOrEqual(390);
  expect(await overflow()).toBeLessThanOrEqual(0);

  await revoke(page, name);
  await expect(rowOf(page, name)).toHaveCount(0);
  expect(await overflow()).toBeLessThanOrEqual(0);
});
