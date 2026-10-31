import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { consentRecord, consentStatus } from '../src/shared/operations/session/consent.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { resetAccountConsents } from './local-d1.ts';
import { routeOperation } from './operations.ts';

const CHECKBOX_NAME = '利用規約とプライバシーポリシーを確認し、同意します';
const UNCONSENTED = { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, latest: null, current: false };

// 同意の行は追記だけで API に戻す操作が無いので、本物の同意を書くテストは前後に seed の未同意へ戻す（e2e/local-d1.ts）。
// 繰り返し（--repeat-each）で毎回未同意から始め、同じ admin を開く a11y の検査にも同意を残さない
test.describe('本物の API', () => {
  test.beforeEach(async () => {
    await resetAccountConsents('admin');
  });
  test.afterEach(async () => {
    await resetAccountConsents('admin');
  });

  test('ログインした人が印を付けて同意し、return_to の画面へ戻り、開き直すと同意済みと出る', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto('/consent?return_to=%2Faoba');
    const checkbox = page.getByRole('checkbox', { name: CHECKBOX_NAME });
    const submit = page.getByRole('button', { name: '同意して進む' });
    await expect(checkbox).toBeVisible();
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await expect(submit).toHaveAttribute('aria-describedby', 'consent-submit-hint');
    await expect(page.locator('#consent-submit-hint')).toHaveText(
      '利用規約とプライバシーポリシーを確認し、印を付けてください。',
    );
    await checkbox.check();
    await expect(submit).toHaveAttribute('aria-disabled', 'false');
    await expect(submit).not.toHaveAttribute('aria-describedby');
    // 説明の要素は残して文だけを空にする（外すと縦中央の紙が縮み、押した位置の下の部品が動く）
    await expect(page.locator('#consent-submit-hint')).toBeEmpty();
    await checkbox.uncheck();
    await expect(submit).toHaveAttribute('aria-describedby', 'consent-submit-hint');
    await expect(page.locator('#consent-submit-hint')).toHaveText(
      '利用規約とプライバシーポリシーを確認し、印を付けてください。',
    );
    await checkbox.check();
    await submit.click();
    await expect(page).toHaveURL(/\/aoba$/);

    await page.goto('/consent');
    await expect(page.getByText('現在の版に同意しています。')).toBeVisible();
    await expect(page.getByText(/^同意した日時: /)).toBeVisible();
    // 日時の値だけが等幅で、ラベルは通常の字（formatDateTime の書式。日付と時刻の間は NBSP）
    await expect(page.locator('.panel-note .mono')).toHaveText(/^\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}$/);
  });

  test('新しいタブで開く2つのリンクは、読み上げに「新しいタブで開きます」を補う', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto('/consent');
    await expect(page.getByRole('link', { name: /^利用規約.*新しいタブで開きます$/ })).toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(page.getByRole('link', { name: /^プライバシーポリシー.*新しいタブで開きます$/ })).toHaveAttribute(
      'target',
      '_blank',
    );
  });
});

test('版が上がった直後の同意は 409 で断られ、読み直した版と更新の知らせが出る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let reads = 0;
  await routeOperation(page, consentStatus, async (call) => {
    reads += 1;
    await call.fulfill(reads === 1 ? { ...UNCONSENTED, terms_version: '2026-10-01' } : UNCONSENTED);
  });
  await routeOperation(page, consentRecord, (call) => call.fail(409, 'conflict'));
  await page.goto('/consent');
  const checkbox = page.getByRole('checkbox', { name: CHECKBOX_NAME });
  await checkbox.check();
  await page.getByRole('button', { name: '同意して進む' }).click();
  await expect(page.getByText('規約が更新されました。内容を確認し直してください。')).toBeVisible();
  await expect(page.getByText(`版: ${TERMS_VERSION}`).first()).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  // 印が外れたので、押せない理由が読み上げに戻る
  await expect(page.getByRole('button', { name: '同意して進む' })).toHaveAttribute(
    'aria-describedby',
    'consent-submit-hint',
  );
  await expect(page.locator('#consent-submit-hint')).toHaveText(
    '利用規約とプライバシーポリシーを確認し、印を付けてください。',
  );
});

test('409 の後の読み直しで同意済みと分かったら、更新の知らせは出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const consented = {
    ...UNCONSENTED,
    latest: {
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      consented_at: '2026-10-31T00:00:00.000Z',
    },
    current: true,
  };
  let reads = 0;
  await routeOperation(page, consentStatus, async (call) => {
    reads += 1;
    await call.fulfill(reads === 1 ? UNCONSENTED : consented);
  });
  await routeOperation(page, consentRecord, (call) => call.fail(409, 'conflict'));
  await page.goto('/consent');
  await page.getByRole('checkbox', { name: CHECKBOX_NAME }).check();
  await page.getByRole('button', { name: '同意して進む' }).click();
  await expect(page.getByText('現在の版に同意しています。')).toBeVisible();
  await expect(page.getByText('規約が更新されました。内容を確認し直してください。')).toHaveCount(0);
});

test('状態を読み込めないときは、もう一度試すとログアウトが出て、試すと続きへ進める', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  let reads = 0;
  await routeOperation(page, consentStatus, async (call) => {
    reads += 1;
    if (reads === 1) await call.fail(500, 'internal');
    else await call.fulfill(UNCONSENTED);
  });
  await page.goto('/consent');
  await expect(page.getByText('同意の状態を読み込めませんでした。もう一度試してください。')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
  await page.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(page.getByRole('checkbox', { name: CHECKBOX_NAME })).toBeVisible();
});

test('409 の後の読み直しに失敗したら、古い版のフォームを残さず、もう一度試すで続きへ進める', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  let reads = 0;
  await routeOperation(page, consentStatus, async (call) => {
    reads += 1;
    if (reads === 2) await call.fail(500, 'internal');
    else await call.fulfill(UNCONSENTED);
  });
  await routeOperation(page, consentRecord, (call) => call.fail(409, 'conflict'));
  await page.goto('/consent');
  await page.getByRole('checkbox', { name: CHECKBOX_NAME }).check();
  await page.getByRole('button', { name: '同意して進む' }).click();
  await expect(page.getByText('同意の状態を読み込めませんでした。もう一度試してください。')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: CHECKBOX_NAME })).toHaveCount(0);
  await page.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(page.getByRole('checkbox', { name: CHECKBOX_NAME })).toBeVisible();
  await expect(page.getByText('同意の状態を読み込めませんでした。もう一度試してください。')).toHaveCount(0);
});
