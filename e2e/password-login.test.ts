// ログインの画面からメールアドレスとパスワードで入る（POST /api/auth/password/login、Issue #256）。
// seed のパスワードの人（seed/passwords.ts）で、本物の API と手元の D1 に当てる。組織が1つの人は組織の画面へ、2つの人は組織の選択へ移る。
// 違うパスワードでは画面を移らずに理由を出し、メールアドレスの欄を残す。
// 繰り返し（--repeat-each）でメールアドレスと IP の枠（10分に10回、30回）を使い切らないよう、場面ごとにパスワードの枠の行を消す
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { SEED_PASSWORD_LOGINS } from '../seed/passwords.ts';
import { PASSWORD_LOGIN_ENABLED } from '../src/shared/password-login-enabled.ts';
import {
  findA11yViolations,
  findOverflowViolations,
  findTargetSizeViolations,
  NARROW_VIEWPORT,
  waitForSettled,
  watchViolations,
} from './helpers.ts';
import { resetPasswordLoginRateLimits } from './local-d1.ts';

// 初版は口と画面を閉じている（PASSWORD_LOGIN_ENABLED、Issue #635）。閉じている間の確かめは e2e/login.test.ts
test.skip(!PASSWORD_LOGIN_ENABLED, 'メールアドレスとパスワードのログインを閉じている間は飛ばす');

const emailField = (page: Page) => page.getByLabel('メールアドレス', { exact: true });
const passwordField = (page: Page) => page.getByLabel('パスワード', { exact: true });
const submitButton = (page: Page) => page.getByRole('button', { name: 'メールアドレスでログイン' });

test.beforeEach(async () => {
  await resetPasswordLoginRateLimits();
});

test('ログインの画面に、GitHub と Google のボタンと並んで、メールアドレスとパスワードの欄とログインのボタンを出す', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'GitHub でログイン' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Google でログイン' })).toBeVisible();
  await expect(emailField(page)).toHaveAttribute('type', 'email');
  await expect(emailField(page)).toHaveAttribute('autocomplete', 'email');
  await expect(passwordField(page)).toHaveAttribute('type', 'password');
  await expect(passwordField(page)).toHaveAttribute('autocomplete', 'current-password');
  await expect(submitButton(page)).toBeVisible();
  // 外の手段のボタンと同じ幅
  const github = await page.getByRole('link', { name: 'GitHub でログイン' }).boundingBox();
  expect((await submitButton(page).boundingBox())?.width).toBe(github?.width);
  expect(await collect()).toEqual([]);
});

// ログインの画面は枠の外で、主な画面の機械の検査（e2e/a11y-*.test.ts、e2e/layout-narrow*.test.ts）に入っていないので、
// 欄を足した画面をここで確かめる。理由を出した状態（違うパスワード）も含める
test('ログインの画面は、幅 390px で横にはみ出さず、押せる範囲が 44px あり、axe の違反が無い', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/login');
  await emailField(page).fill(SEED_PASSWORD_LOGINS.single.email);
  await passwordField(page).fill(`${SEED_PASSWORD_LOGINS.single.password}-wrong`);
  await submitButton(page).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await findOverflowViolations(page)).toEqual([]);
  expect(await findTargetSizeViolations(page)).toEqual([]);
  expect(await findA11yViolations(page)).toEqual([]);
});

test('入れる組織が1つの人は、パスワードで入るとその組織の画面に移る', async ({ page }) => {
  const person = SEED_PASSWORD_LOGINS.single;
  await page.goto('/login');
  await emailField(page).fill(person.email);
  await passwordField(page).fill(person.password);
  await submitButton(page).click();
  await expect(page).toHaveURL(/\/yuzu$/);
  await expect(page.locator('.me')).toContainText(person.name);
});

test('入れる組織が2つの人は、パスワードで入ると組織の選択に移る', async ({ page }) => {
  const person = SEED_PASSWORD_LOGINS.multi;
  await page.goto('/login');
  await emailField(page).fill(person.email);
  await passwordField(page).fill(person.password);
  await passwordField(page).press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: '組織を選ぶ' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: /ゆず書房/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /みなも舎/ })).toBeVisible();
});

test('ログインの画面の戻る先（return_to）があれば、パスワードで入った後にそこへ移る', async ({ page }) => {
  const person = SEED_PASSWORD_LOGINS.multi;
  await page.goto(`/login?return_to=${encodeURIComponent('/minamo')}`);
  await emailField(page).fill(person.email);
  await passwordField(page).fill(person.password);
  await submitButton(page).click();
  await expect(page).toHaveURL(/\/minamo$/);
  // ログインの画面は location.replace で文書ごと移るので、URL は画面が描かれる前に変わる。
  // URL は新しい文書が描かれる前に変わるので、移った先の画面が出て読み込みが終わるのを待つ（#510）
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  await expect(page.locator('.me')).toContainText(person.name);
  await waitForSettled(page);
  await page.mouse.move(0, 0);
});

test('違うパスワードでは、画面を移らずに理由を出し、メールアドレスを残してパスワードを空にする', async ({ page }) => {
  const person = SEED_PASSWORD_LOGINS.single;
  const collect = await watchViolations(page);
  await page.goto('/login');
  await emailField(page).fill(person.email);
  await passwordField(page).fill(`${person.password}-wrong`);
  await submitButton(page).click();
  await expect(page.getByRole('alert')).toHaveText(
    'メールアドレスかパスワードが違います。確かめて、もう一度ログインしてください。',
  );
  await expect(page).toHaveURL(/\/login$/);
  await expect(emailField(page)).toHaveValue(person.email);
  await expect(passwordField(page)).toHaveValue('');
  // もう一度送れる（ボタンは止まったままにならない）
  await expect(submitButton(page)).not.toHaveAttribute('aria-disabled', 'true');
  // 断った応答（401）はブラウザがコンソールに出す。それ以外のエラーと CSP の違反は無い
  expect((await collect()).filter((entry) => !entry.includes('status of 401'))).toEqual([]);
});

test('登録の無いメールアドレスも、違うパスワードと同じ文言で断る', async ({ page }) => {
  await page.goto('/login');
  // 欄の文字が画面に写るので、乱数を混ぜずに決まったアドレスにする（#491）。メールアドレスの枠は beforeEach で消すので、毎回同じでも使い切らない
  await emailField(page).fill('nobody@example.test');
  await passwordField(page).fill(SEED_PASSWORD_LOGINS.single.password);
  await submitButton(page).click();
  await expect(page.getByRole('alert')).toHaveText(
    'メールアドレスかパスワードが違います。確かめて、もう一度ログインしてください。',
  );
});

test('送っている間はボタンを押せなくし、文言を変える。回数の上限（429）は、試行が多すぎる文言を出す', async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 応答を止めて、送っている間の画面を見る。返すのは回数の上限の応答（本物の枠は使い切らない）
  await page.route('**/api/auth/password/login', async (route) => {
    await held;
    await route.fulfill({ status: 429, json: { error: { code: 'rate_limited', message: 'rate limited' } } });
  });
  await page.goto('/login');
  await emailField(page).fill(SEED_PASSWORD_LOGINS.single.email);
  await passwordField(page).fill(SEED_PASSWORD_LOGINS.single.password);
  await submitButton(page).click();
  const moving = page.getByRole('button', { name: 'ログインしています' });
  await expect(moving).toHaveAttribute('aria-disabled', 'true');
  release();
  await expect(page.getByRole('alert')).toContainText('ログインの試行が多すぎます');
  await expect(submitButton(page)).toBeVisible();
});

test('入れる組織が無い（403 の denied）と、招待された手段を問わない文言を出す', async ({ page }) => {
  await page.route('**/api/auth/password/login', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'forbidden', message: 'forbidden', details: { reason: 'denied' } } },
    }),
  );
  await page.goto('/login');
  await emailField(page).fill(SEED_PASSWORD_LOGINS.single.email);
  await passwordField(page).fill(SEED_PASSWORD_LOGINS.single.password);
  await submitButton(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'ログインできませんでした。どの組織のワークスペースにも所属しておらず',
  );
  await expect(page.getByRole('alert')).not.toContainText('GitHub');
  await expect(emailField(page)).toHaveValue(SEED_PASSWORD_LOGINS.single.email);
});

test('欄が空なら送らずに理由を出し、理由は欄に結ばれる', async ({ page }) => {
  let sent = 0;
  await page.route('**/api/auth/password/login', (route) => {
    sent += 1;
    return route.continue();
  });
  await page.goto('/login');
  await emailField(page).fill(SEED_PASSWORD_LOGINS.single.email);
  await submitButton(page).click();
  await expect(page.getByRole('alert')).toHaveText('メールアドレスとパスワードを入れてください。');
  await expect(passwordField(page)).toHaveAccessibleDescription('メールアドレスとパスワードを入れてください。');
  expect(sent).toBe(0);
});
