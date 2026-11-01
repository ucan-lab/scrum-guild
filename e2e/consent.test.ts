import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { consentRecord, consentStatus } from '../src/shared/operations/session/consent.ts';
import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled } from './helpers.ts';
import { resetAccountConsents, seedOldAccountConsent } from './local-d1.ts';
import { routeOperation } from './operations.ts';

const CHECKBOX_NAME = '利用規約とプライバシーポリシーを確認し、同意します';
// 今の版より前の版（2026-10-01）への同意。今の版の改定日は 2026-10-31 以降
const OLD_CONSENT = {
  termsVersion: '2026-10-01',
  privacyVersion: '2026-10-01',
  consentedAt: '2026-10-01T00:00:00.000Z',
};
const UNCONSENTED = { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, latest: null, current: false };

// 同意の行は追記だけで API に戻す操作が無いので、本物の同意を書くテストは前後に seed の未同意（unconsented）へ戻す（e2e/local-d1.ts）。
// 繰り返し（--repeat-each）で毎回未同意から始める。同意していない人は seed の unconsented だけなので、同じ人の行を書くテストはこのファイルにまとめる
test.describe('本物の API', () => {
  test.beforeEach(async () => {
    await resetAccountConsents('unconsented');
  });
  test.afterEach(async () => {
    await resetAccountConsents('unconsented');
  });

  test('同意していない人が組織の画面を開くと同意の画面に移り、同意すると開こうとした画面に戻る', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'unconsented');
    await page.goto('/aoba');
    await expect(page).toHaveURL(/\/consent\?return_to=%2Faoba$/);
    await page.getByRole('checkbox', { name: CHECKBOX_NAME }).check();
    await page.getByRole('button', { name: '同意して進む' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    // unconsented はどの組織にも入っていないので、戻った /aoba は「見つからない」の画面になる。この画面が描かれるまで待ってから、
    // 同意の画面へ戻っていないことを確かめる（同意が記録されず /consent へ戻る往復を、URL だけの確かめで見逃さないため）
    await expect(page.getByRole('heading', { name: '組織が見つかりません' })).toBeVisible();
    await expect(page).not.toHaveURL(/\/consent/);
  });

  test('同意していない人が / を開くと同意の画面に移る', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'unconsented');
    await page.goto('/');
    await expect(page).toHaveURL(/\/consent/);
    await expect(page.getByRole('checkbox', { name: CHECKBOX_NAME })).toBeVisible();
  });

  test('同意済みの admin は組織の画面をそのまま開ける', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.goto('/aoba');
    // goto は load イベントで戻り、画面の load（API の呼び出し）はその後に走る。読み込みが終わってから、移っていないことを確かめる
    await waitForSettled(page);
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(page).not.toHaveURL(/\/consent/);
  });

  test('ログインした人が印を付けて同意し、return_to の画面へ戻り、開き直すと同意済みと出る', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'unconsented');
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
    // 説明は外さず、文を描いたまま隠す（外すと縦中央の紙が縮み、押した位置の下の部品が動く）
    await expect(page.locator('#consent-submit-hint')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#consent-submit-hint')).toBeHidden();
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

  test('旧い版に同意した人が開くと、改めたことと改定日と改定の履歴へのリンクが出て、同意すると return_to に戻る', async ({
    page,
    context,
    baseURL,
  }) => {
    await seedOldAccountConsent('unconsented', OLD_CONSENT);
    await signIn(context, baseURL, 'unconsented');
    await page.goto('/consent?return_to=%2Faoba');
    const revised = page.locator('.callout.is-info');
    await expect(revised).toContainText('利用規約とプライバシーポリシーが改められました');
    await expect(revised.locator('.mono')).toHaveText([`改定日: ${TERMS_VERSION}`, `改定日: ${PRIVACY_VERSION}`]);
    const termsHistory = revised.getByRole('link', { name: /^改定の履歴を見る.*利用規約.*新しいタブで開きます$/ });
    await expect(termsHistory).toHaveAttribute('href', '/terms#revision-history');
    await expect(termsHistory).toHaveAttribute('target', '_blank');
    const privacyHistory = revised.getByRole('link', {
      name: /^改定の履歴を見る.*プライバシーポリシー.*新しいタブで開きます$/,
    });
    await expect(privacyHistory).toHaveAttribute('href', '/privacy#revision-history');
    await expect(privacyHistory).toHaveAttribute('target', '_blank');
    // 案内は主文の上に出る
    const lead = page.getByText('を使うには、利用規約とプライバシーポリシーを確認してください。');
    expect((await revised.boundingBox())?.y).toBeLessThan((await lead.boundingBox())?.y ?? 0);

    await page.getByRole('checkbox', { name: CHECKBOX_NAME }).check();
    await page.getByRole('button', { name: '同意して進む' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    // 同意した後に開き直すと、今の版に同意済みなので、案内は出ない
    await page.goto('/consent');
    await expect(page.getByText('現在の版に同意しています。')).toBeVisible();
    await expect(page.locator('.callout.is-info')).toHaveCount(0);
  });

  test('利用規約だけが旧い版の人には、利用規約だけを改めたと案内する', async ({ page, context, baseURL }) => {
    await seedOldAccountConsent('unconsented', { ...OLD_CONSENT, privacyVersion: PRIVACY_VERSION });
    await signIn(context, baseURL, 'unconsented');
    await page.goto('/consent');
    const revised = page.locator('.callout.is-info');
    await expect(revised).toContainText('利用規約が改められました');
    await expect(revised).not.toContainText('プライバシーポリシー');
    await expect(revised.locator('.mono')).toHaveText([`改定日: ${TERMS_VERSION}`]);
    await expect(revised.getByRole('link')).toHaveCount(1);
  });

  test('プライバシーポリシーだけが旧い版の人には、プライバシーポリシーだけを改めたと案内する', async ({
    page,
    context,
    baseURL,
  }) => {
    await seedOldAccountConsent('unconsented', { ...OLD_CONSENT, termsVersion: TERMS_VERSION });
    await signIn(context, baseURL, 'unconsented');
    await page.goto('/consent');
    const revised = page.locator('.callout.is-info');
    await expect(revised).toContainText('プライバシーポリシーが改められました');
    await expect(revised).not.toContainText('利用規約が改められました');
    await expect(revised.locator('.mono')).toHaveText([`改定日: ${PRIVACY_VERSION}`]);
    const history = revised.getByRole('link');
    await expect(history).toHaveCount(1);
    await expect(history).toHaveAttribute('href', '/privacy#revision-history');
  });

  test('同意の行が無い人（初めて同意する人）には、改めた案内を出さない', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'unconsented');
    await page.goto('/consent');
    await expect(page.getByRole('checkbox', { name: CHECKBOX_NAME })).toBeVisible();
    await expect(page.locator('.callout.is-info')).toHaveCount(0);
    await expect(page.getByText('改められました')).toHaveCount(0);
  });

  for (const width of [1280, 390]) {
    test(`印を付けても紙の高さと送信ボタンの位置が動かない（幅 ${width}px）`, async ({ page, context, baseURL }) => {
      await signIn(context, baseURL, 'admin');
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/consent');
      const checkbox = page.getByRole('checkbox', { name: CHECKBOX_NAME });
      const submit = page.getByRole('button', { name: '同意して進む' });
      const sheet = page.locator('.gate-sheet');
      await expect(checkbox).toBeVisible();
      const before = { sheet: await sheet.boundingBox(), submit: await submit.boundingBox() };
      await checkbox.check();
      await expect(submit).toHaveAttribute('aria-disabled', 'false');
      const after = { sheet: await sheet.boundingBox(), submit: await submit.boundingBox() };
      expect(after.sheet?.height).toBe(before.sheet?.height);
      expect(after.submit?.y).toBe(before.submit?.y);
    });
  }

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
  await signIn(context, baseURL, 'unconsented');
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

test('送っている間は印を外せず、記録に失敗しても印は付いたまま、そのままもう一度押せる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await routeOperation(page, consentStatus, (call) => call.fulfill(UNCONSENTED));
  await routeOperation(page, consentRecord, async (call) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await call.fail(500, 'internal');
  });
  await page.goto('/consent');
  const checkbox = page.getByRole('checkbox', { name: CHECKBOX_NAME });
  const submit = page.getByRole('button', { name: /^同意/ });
  await checkbox.check();
  await submit.click();
  // 送っている間に外すと、失敗した後に押せなくなる
  await expect(checkbox).toBeDisabled();
  await expect(page.getByText('同意を記録できませんでした。もう一度試してください。')).toBeVisible();
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole('button', { name: '同意して進む' })).toHaveAttribute('aria-disabled', 'false');
});

test('409 の後の読み直しで同意済みと分かったら、更新の知らせは出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'unconsented');
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
  await signIn(context, baseURL, 'unconsented');
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
  await signIn(context, baseURL, 'unconsented');
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
