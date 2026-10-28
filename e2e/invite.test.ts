import { expect, test } from './fixtures.ts';
import { watchViolations } from './helpers.ts';

// 招待の URL を開く画面（/invite#<秘密>）。本物の Google へは行かないので、ログインを始める POST の応答は差し替える。
// 開始の API の処理（形の検査、cross-site の拒否、レート制限、結ぶ処理）は test/invite-google.test.ts

const CLAIM_TOKEN = 'Qm7tX2vLr9aKpE4wZc8hN3bYd6fGs1uJ0oTiRl5eWxA';

test('秘密を読んだらすぐ URL から消し、ボタンを押すまでログインを始めず、押すと秘密を POST の本文だけで送る', async ({
  page,
}) => {
  const posts: {
    method: string;
    contentType: string | undefined;
    body: string | null;
    url: string;
    referer: string | undefined;
  }[] = [];
  await page.route('**/api/auth/google/start', async (route) => {
    const request = route.request();
    posts.push({
      method: request.method(),
      contentType: request.headers()['content-type'],
      body: request.postData(),
      url: request.url(),
      referer: request.headers()['referer'],
    });
    // Google へ移す代わりに、ログインの画面へ移す（本物の Google へは行かない）
    await route.fulfill({ status: 302, headers: { Location: '/login?error=invite' } });
  });
  const collect = await watchViolations(page);

  const lengthBefore = await page.evaluate(() => history.length);
  const response = await page.goto(`/invite#${CLAIM_TOKEN}`);
  // 画面のヘッダー: Referer を送らない
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  // フォームは自分の API に POST し、302 で Google の認可の画面へ移る。Chrome は form-action をリダイレクトの先にも当てるので、
  // Google の認可の画面のホストを許している（許さないと 302 が CSP で止まる）
  expect(response?.headers()['content-security-policy']).toContain("form-action 'self' https://accounts.google.com");
  await expect(page.getByRole('heading', { level: 1, name: 'Scrum Guild への招待' })).toBeVisible();
  await expect(page).toHaveTitle('Scrum Guild への招待 - Scrum Guild');
  // 秘密は URL から消える（履歴にも残らない）。組織の名前は出さない
  await expect(page).toHaveURL(/\/invite$/);
  expect(await page.evaluate(() => location.hash)).toBe('');
  // 履歴の項目の state にも残さない（浅いルーティングは元の URL を state に残す）。項目も、開いた分の1つしか増やさない
  expect(JSON.stringify(await page.evaluate(() => history.state))).not.toContain(CLAIM_TOKEN);
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore + 1);
  await expect(page.locator('body')).not.toContainText(CLAIM_TOKEN);
  expect(await page.locator('input[type="hidden"]').evaluate((input: HTMLInputElement) => input.value)).toBe('');
  // 左のメニューも上の帯も出ない
  await expect(page.locator('.app')).toHaveCount(0);

  // ボタンを押すまでは、ログインを始めない
  await page.waitForTimeout(300);
  expect(posts).toEqual([]);

  await page.getByRole('button', { name: 'Google でログイン' }).click();
  await expect(page).toHaveURL(/\/login\?error=invite$/);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: `claim_token=${CLAIM_TOKEN}`,
  });
  // Referer は付かない
  expect(posts[0]!.referer).toBeUndefined();
  // 秘密は URL のクエリにも、フラグメントにも出ない
  expect(posts[0]!.url).not.toContain(CLAIM_TOKEN);
  expect(page.url()).not.toContain(CLAIM_TOKEN);
  await expect(page.getByRole('alert')).toContainText('この招待の URL は使えません');
  expect(await collect()).toEqual([]);
});

test('秘密が無い、形の合わない URL は、使えない旨を出してボタンを出さない', async ({ page }) => {
  const posts: string[] = [];
  await page.route('**/api/auth/google/start', (route) => {
    posts.push(route.request().url());
    return route.abort();
  });
  for (const hash of ['', '#', '#short', `#${CLAIM_TOKEN}x`, `#${CLAIM_TOKEN.slice(0, 42)}!`]) {
    // 前の URL とフラグメントだけが違う移動は、画面を読み込み直さない同じ文書の移動になる。毎回読み込み直す
    await page.goto('about:blank');
    await page.goto(`/invite${hash}`);
    await expect(page.getByRole('alert')).toContainText('この招待の URL は使えません');
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/invite$/);
  }
  expect(posts).toEqual([]);
});

test('URL を置き換える移動が遅く、読み込み中の表示で画面が作り直されても、秘密を失わずにボタンを出す', async ({
  page,
}) => {
  // root のレイアウトは、移動が 300ms を超えると画面を読み込み中の表示に替える。その待ちをすぐに切らせ、遅い端末を再現する。
  // 作り直しが起きたことは、読み込み中の表示が一度出たことで確かめる（起きないまま通ると、秘密を失う退行を見逃す）
  await page.addInitScript(() => {
    const original = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
      original(handler, timeout === 300 ? 0 : timeout, ...rest)) as typeof window.setTimeout;
    const seen = { loading: false };
    Object.assign(window, { e2eLoadingSeen: seen });
    new MutationObserver(() => {
      if (document.body?.textContent?.includes('読み込んでいます')) seen.loading = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`/invite#${CLAIM_TOKEN}`);
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { e2eLoadingSeen: { loading: boolean } }).e2eLoadingSeen.loading),
  ).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page).toHaveURL(/\/invite$/);
});

test('URL を読み終えてボタンを出したことを、読み上げの領域で伝える', async ({ page }) => {
  await page.goto(`/invite#${CLAIM_TOKEN}`);
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
  // ボタンは URL を置き換えた後に足すので、後から出たことを読み上げに伝える（常にある領域の文字を替える）
  await expect(page.getByRole('status').filter({ hasText: '招待の URL を読みました' })).toHaveCount(1);
});

test('URL から秘密を消せなかったときは、ボタンを出さず使えない旨を出す', async ({ page }) => {
  // SvelteKit の移動が URL を置き換えないまま終わった場面（移動の失敗、ほかの移動に取って代わられた）を、置き換えを
  // 今の URL のままにして再現する
  await page.addInitScript(() => {
    const original = History.prototype.replaceState;
    History.prototype.replaceState = function (this: History, data: unknown) {
      original.call(this, data, '', location.href);
    };
  });
  await page.goto(`/invite#${CLAIM_TOKEN}`);
  await expect(page.getByRole('alert')).toContainText('この招待の URL は使えません');
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toHaveCount(0);
  expect(page.url()).toContain(CLAIM_TOKEN);
});

test('同じ文書のまま画面を移ってから、秘密の無い /invite へ戻ると、前の秘密を使わず使えない旨を出す', async ({
  page,
}) => {
  // 画面の中の移動（SvelteKit がリンクの押下を受けて文書を読み込み直さない移動）で離れて戻る
  async function navigateInApp(href: string): Promise<void> {
    await page.evaluate((target) => {
      const link = document.createElement('a');
      link.href = target;
      link.textContent = 'e2e の移動';
      document.querySelector('main')!.append(link);
      link.click();
    }, href);
  }
  await page.goto(`/invite#${CLAIM_TOKEN}`);
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
  const documentId = await page.evaluate(() => {
    const id = Math.random().toString(36);
    Object.assign(window, { e2eDocumentId: id });
    return id;
  });
  await navigateInApp('/login');
  await expect(page).toHaveURL(/\/login$/);
  await navigateInApp('/invite');
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole('alert')).toContainText('この招待の URL は使えません');
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toHaveCount(0);
  // 読み込み直さずに戻ったこと（文書が同じ）
  expect(await page.evaluate(() => (window as unknown as { e2eDocumentId?: string }).e2eDocumentId)).toBe(documentId);
});

test('/login?error=invite は、使えない旨を出す', async ({ page }) => {
  await page.goto('/login?error=invite');
  await expect(page.getByRole('alert')).toContainText(
    'この招待の URL は使えません。期限が切れたか、取り消されたか、招待されたのと別のアカウントでログインしています。招待した人に確かめるか、届いた招待の URL をもう一度開いてください。もう入れる冒険者ギルドがある人は、下のボタンからそのままログインできます。',
  );
});

test('戻る・再読み込みで URL の続きが消えた画面は、届いた招待の URL をもう一度開くよう案内する', async ({ page }) => {
  await page.goto(`/invite#${CLAIM_TOKEN}`);
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('届いた招待の URL をもう一度開いてください');
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toHaveCount(0);
});

test('ボタンを押した後の2回目以降の押下は無視し、文言を進行中に替える。読み上げの領域は常にある', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/auth/google/start', async (route) => {
    posts++;
    await route.fulfill({ status: 302, headers: { Location: '/login?error=invite' } });
  });
  await page.goto(`/invite#${CLAIM_TOKEN}`);
  // 画面全体の読み込みの領域と、この画面の領域。どちらも常に置き、文字だけが替わる
  const statuses = page.locator('[role="status"]');
  await expect(statuses).toHaveCount(2);
  await expect(statuses.filter({ hasText: 'Google へ移っています' })).toHaveCount(0);
  // 移動が始まると Playwright は DOM を読めなくなるので、ページの中で2回押して、移る前の状態を読む
  const before = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('main button.is-google')!;
    button.click();
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      ariaDisabled: button.getAttribute('aria-disabled'),
      label: button.textContent,
      statuses: [...document.querySelectorAll('[role="status"]')].map((element) => element.textContent),
    };
  });
  expect(before.ariaDisabled).toBe('true');
  expect(before.label).toBe('Google へ移っています');
  expect(before.statuses).toHaveLength(2);
  expect(before.statuses).toContain('Google へ移っています');
  await expect(page).toHaveURL(/\/login\?error=invite$/);
  expect(posts).toBe(1);
});

test('押したときに隠し欄へ入れた秘密は、ページを離れるときに消す（bfcache の復元で DOM に残さない）', async ({
  page,
}) => {
  let body = '';
  await page.route('**/api/auth/google/start', async (route) => {
    body = route.request().postData() ?? '';
    await route.fulfill({ status: 302, headers: { Location: '/login?error=invite' } });
  });
  await page.goto(`/invite#${CLAIM_TOKEN}`);
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
  // 移動が始まると DOM を読めなくなるので、押した直後と pagehide の後の隠し欄をページの中で読む
  const values = await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>('main input[type="hidden"]')!;
    document.querySelector<HTMLButtonElement>('main button.is-google')!.click();
    const pressed = field.value;
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return { pressed, left: field.value };
  });
  expect(values.pressed).toBe(CLAIM_TOKEN);
  expect(values.left).toBe('');
  await expect(page).toHaveURL(/\/login\?error=invite$/);
  // 隠し欄を空にしても、送った本文には秘密が入っている
  expect(new URLSearchParams(body).get('claim_token')).toBe(CLAIM_TOKEN);
});

test('ほかの画面の Referrer-Policy は変えない', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
});
