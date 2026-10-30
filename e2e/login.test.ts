import { expect, test } from './fixtures.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { signIn } from './helpers.ts';

// ログインの画面（枠の外）と、ログインの API。本物の GitHub へは行かない（ログインを飛ばす口は作らず、seed のセッションの Cookie で通す。
// docs/development.md の「開発とテストでのログイン」）。seed を入れた手元の D1（pnpm db:seed）が要る

test('/login は枠の外に GitHub のボタンを出す', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'GitHub でログイン' })).toHaveAttribute(
    'href',
    '/api/auth/github/start?return_to=%2F',
  );
  await expect(page.getByRole('link', { name: 'Google でログイン' })).toHaveAttribute(
    'href',
    '/api/auth/google/start?return_to=%2F',
  );
  // 左のメニューも上の帯も出ない
  await expect(page.locator('.app')).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page).toHaveTitle('ログイン - Scrum Guild');
});

test('Google のボタンは GitHub と同じ幅で、ロゴが出る', async ({ page }) => {
  await page.goto('/login');
  const google = page.getByRole('link', { name: 'Google でログイン' });
  const github = page.getByRole('link', { name: 'GitHub でログイン' });
  expect((await google.boundingBox())?.width).toBe((await github.boundingBox())?.width);
  await expect(google.locator('svg.google-mark')).toBeVisible();
});

// Google のボタンの明暗は、テーマの指定が無い既定とシンプル（自動）だけ OS の明暗に従い、
// ダークのテーマ（simple_dark、modern）はダーク版、ライトのテーマ（simple_light、medieval）はライト版になる
const googleLight = { background: 'rgb(255, 255, 255)', border: 'rgb(116, 119, 117)', color: 'rgb(31, 31, 31)' };
const googleDark = { background: 'rgb(19, 19, 20)', border: 'rgb(142, 145, 143)', color: 'rgb(227, 227, 227)' };
const googleThemes: [theme: string | null, os: 'light' | 'dark', expected: typeof googleLight][] = [
  [null, 'light', googleLight],
  [null, 'dark', googleDark],
  ['simple', 'light', googleLight],
  ['simple', 'dark', googleDark],
  ['simple_light', 'dark', googleLight],
  ['simple_dark', 'light', googleDark],
  ['medieval', 'dark', googleLight],
  ['modern', 'light', googleDark],
];

for (const [theme, os, expected] of googleThemes) {
  test(`Google のボタンの色: テーマ ${theme ?? '（指定なし）'}、OS が${os === 'dark' ? 'ダーク' : 'ライト'}なら${expected === googleDark ? 'ダーク版' : 'ライト版'}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: os });
    await page.goto('/login');
    const google = page.getByRole('link', { name: 'Google でログイン' });
    // 画面に当てたテーマを直に替える（theme-init が覚えた値を当てるのと同じ data-theme の属性）。
    // ログインの画面は枠の外なので、読み込みの後に画面がテーマを既定に戻す（organization.svelte.ts）。
    // 戻されても確かめられるよう、読むたびに当て直す。色は短く遷移する（.btn の transition）ので、落ち着くまで待つ
    await expect
      .poll(() =>
        google.evaluate((element, value) => {
          if (value === null) delete document.documentElement.dataset.theme;
          else document.documentElement.dataset.theme = value;
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, border: style.borderTopColor, color: style.color };
        }, theme),
      )
      .toEqual(expected);
  });
}

test('ログインしていない人が組織の画面を開くと、ログインの画面に移り、そこで止まって、元のパスを開始の URL に渡す', async ({
  page,
}) => {
  await page.goto('/aoba?tab=1');
  await expect(page).toHaveURL(/\/login\?return_to=/);
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  // 移り続けない（/login の画面で止まる）
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/login\?return_to=/);
  await expect(page.getByRole('link', { name: 'GitHub でログイン' })).toHaveAttribute(
    'href',
    `/api/auth/github/start?return_to=${encodeURIComponent('/aoba?tab=1')}`,
  );
});

test('return_to は自分のサイトのパスだけを開始の URL に渡す', async ({ page }) => {
  const button = page.getByRole('link', { name: 'GitHub でログイン' });
  await page.goto('/login?return_to=%2Faoba%2Fboard%3Ftab%3D1');
  await expect(button).toHaveAttribute('href', '/api/auth/github/start?return_to=%2Faoba%2Fboard%3Ftab%3D1');

  for (const bad of ['https%3A%2F%2Fevil.example%2F', '%2F%2Fevil.example', '%2F%5Cevil.example', '%2Fapi%2Fhealth']) {
    await page.goto(`/login?return_to=${bad}`);
    await expect(button).toHaveAttribute('href', '/api/auth/github/start?return_to=%2F');
  }
});

test('?error= の理由を、辞書の文言で出す。知らない値は出さない', async ({ page }) => {
  await page.goto('/login?error=denied');
  await expect(page.getByRole('alert')).toContainText(
    'ログインできませんでした。どの組織のワークスペースにも所属しておらず',
  );
  await page.goto('/login?error=suspended');
  await expect(page.getByRole('alert')).toHaveText(
    'ログインできませんでした。所属しているか招待されている組織は停止しています。運用者に問い合わせてください。',
  );
  await page.goto('/login?error=retry');
  await expect(page.getByRole('alert')).toHaveText('ログインを完了できませんでした。もう一度ログインしてください。');
  await page.goto('/login?error=too_many');
  await expect(page.getByRole('alert')).toContainText('ログインの試行が多すぎます');
  await page.goto('/login?error=unavailable');
  await expect(page.getByRole('alert')).toContainText('いまログインを受け付けられません');
  await page.goto('/login?error=%3Cscript%3E');
  await expect(page.getByRole('alert')).toHaveCount(0);
  // 継承したキー（constructor など）で引いて、画面が壊れない
  for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    await page.goto(`/login?error=${inherited}`);
    await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'GitHub でログイン' })).toBeVisible();
  }
});

test('ログインの開始は Worker が 302 で答え、画面の fallback を返さない', async ({ request }) => {
  const res = await request.get('/api/auth/github/start?return_to=%2Faoba', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  // 開発用の OAuth App を .dev.vars に入れていれば GitHub へ、無ければログインの画面へ戻る
  expect(res.headers().location).toMatch(
    /^(https:\/\/github\.com\/login\/oauth\/authorize\?|\/login\?error=unavailable)/,
  );
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('戻り先は、state の Cookie が無ければログインの画面へ戻す', async ({ request }) => {
  const res = await request.get('/api/auth/github/callback?code=abc&state=' + 'A'.repeat(43), { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toMatch(/^\/login\?error=(retry|unavailable)$/);
});

test.describe('seed のセッション', () => {
  const origin = (baseURL: string | undefined) => new URL(baseURL ?? '').origin;

  test('Cookie があれば me が自分のアカウントを返し、無ければ 401', async ({ context, request, baseURL }) => {
    const headers = { Origin: origin(baseURL) };
    const anonymous = await request.post('/api/me', { headers, data: {} });
    expect(anonymous.status()).toBe(401);
    expect((await anonymous.json()).error.code).toBe('unauthenticated');

    await signIn(context, baseURL, 'admin');
    const mine = await context.request.post('/api/me', { headers, data: {} });
    expect(mine.status()).toBe(200);
    expect(await mine.json()).toEqual({
      account_id: SEED_SESSIONS.admin.accountId,
      login_provider: 'github',
      login_name: 'minato--seed',
      display_name: 'ミナト',
      avatar_url: null,
    });
  });

  test('Origin が違う呼び出しは 403', async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    const res = await context.request.post('/api/me', { headers: { Origin: 'https://evil.example' }, data: {} });
    expect(res.status()).toBe(403);
  });
});
