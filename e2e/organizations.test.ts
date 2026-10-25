// 組織の選択と組織の枠。seed のセッション（seed/sessions.ts）の Cookie で、組織が1つの人、2つの人、入れない組織を開いた人を確かめる
import { expect, test, type Page } from '@playwright/test';
import type { OutputOf } from '../src/shared/operations/define.ts';
import type { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { signIn, watchViolations } from './helpers.ts';

// 組織の操作の応答を書き換える。サーバーの応答をそのまま取り、必要な項目だけ上書きして返す
async function patchOrganization(page: Page, slug: string, patch: (body: OutputOf<typeof organizationInfo>) => void) {
  await page.route(`**/api/${slug}/organization`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as OutputOf<typeof organizationInfo>;
    patch(body);
    await route.fulfill({ response, json: body });
  });
}

// 組織の切り替え（メニューの上の開閉するメニュー）
const menuButton = (page: Page) => page.locator('.org-menu-button');
const menuLinks = (page: Page) => page.locator('.org-menu-list a');

// 横にはみ出していないか
const overflowOf = (page: Page) =>
  page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));

test.describe('組織が1つの人（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('/ を開くと組織の画面に入り、組織の切り替えは出ない', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    await expect(page.locator('.me')).toContainText('ハルカ');
    await expect(page.locator('.me .chip')).toHaveCount(0);
    await expect(menuButton(page)).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('組織の既定のテーマを当て、localStorage にも覚える', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.organization.theme = 'medieval';
    });
    await page.goto('/aoba');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'medieval');
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).toBe('medieval');
  });

  test('自分のテーマがあれば、組織の既定より優先する', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.organization.theme = 'medieval';
      body.me.theme = 'modern';
    });
    await page.goto('/aoba');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'modern');
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).toBe('modern');
  });

  test('組織の言葉づかいを当てる（スクラムの言葉では管理者の印が「管理者」になる）', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.organization.vocabulary = 'scrum';
      body.me.is_admin = true;
    });
    await page.goto('/aoba');
    await expect(page.locator('.me .chip')).toHaveText('管理者');
  });

  test('組織にワークスペースが1つも無い管理者には、最初のワークスペースを作る案内と作るボタンを出し、メニューは組織の画面だけ', async ({
    page,
  }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.me.is_admin = true;
      body.organization.has_workspaces = false;
      body.workspaces = [];
    });
    await page.goto('/aoba');
    await expect(page.getByText('まだパーティがありません')).toBeVisible();
    await expect(page.getByText('最初のパーティを作ります。')).toBeVisible();
    await expect(page.locator('.empty a')).toHaveCount(0);
    await expect(page.locator('.empty button')).toHaveText('パーティを作る');
    await expect(page.locator('.nav-group')).toHaveCount(0);
  });

  test('組織にワークスペースはあるが所属が0件の管理者には、所属が無いことの案内を出す', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.me.is_admin = true;
      body.organization.has_workspaces = true;
      body.workspaces = [];
    });
    await page.goto('/aoba');
    await expect(page.getByText('どのパーティにも所属していません')).toBeVisible();
    await expect(page.getByText('まだパーティがありません')).toHaveCount(0);
    await expect(page.locator('.empty a, .empty button')).toHaveCount(0);
  });

  test('所属のある人には、ワークスペースの案内を出さない', async ({ page }) => {
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    await expect(page.getByText('まだパーティがありません')).toHaveCount(0);
    await expect(page.getByText('どのパーティにも所属していません')).toHaveCount(0);
  });

  test('入れない組織の slug と存在しない slug は、同じ「見つからない」の画面になり、API はどちらも 404', async ({
    page,
    baseURL,
  }) => {
    const screens: string[] = [];
    for (const slug of ['hibari', 'no-such-organization']) {
      await page.goto(`/${slug}`);
      await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドが見つかりません' })).toBeVisible();
      await expect(page).toHaveTitle('冒険者ギルドが見つかりません - Scrum Guild');
      await expect(page.locator('.nav')).toHaveCount(0);
      screens.push(await page.locator('body').innerText());
    }
    expect(screens[0]).toBe(screens[1]);

    const bodies: string[] = [];
    for (const slug of ['hibari', 'no-such-organization']) {
      const res = await page.request.post(`/api/${slug}/organization`, {
        headers: { Origin: baseURL ?? '', 'Content-Type': 'application/json' },
        data: {},
      });
      expect(res.status()).toBe(404);
      bodies.push(await res.text());
    }
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('見つからない画面の「一覧へ」で、入れる組織の画面に戻る', async ({ page }) => {
    await page.goto('/hibari');
    await page.getByRole('link', { name: '冒険者ギルドの一覧へ' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
  });

  // 見つからないのは、API が not_found の 404 を返したときだけ
  for (const [name, response] of [
    ['503 の unavailable', { status: 503, json: { error: { code: 'unavailable', message: 'x' } } }],
    ['403 の forbidden', { status: 403, json: { error: { code: 'forbidden', message: 'x' } } }],
    ['not_found 以外の code の 404', { status: 404, json: { error: { code: 'invalid_input', message: 'x' } } }],
    ['JSON でない 404', { status: 404, body: 'Not Found', contentType: 'text/plain' }],
  ] as const) {
    test(`${name}は、見つからない画面ではなく読み込みの失敗を出す`, async ({ page }) => {
      await page.route('**/api/aoba/organization', (route) => route.fulfill(response));
      await page.goto('/aoba');
      await expect(page.getByRole('heading', { level: 1, name: '読み込めませんでした' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '冒険者ギルドが見つかりません' })).toHaveCount(0);
    });
  }

  test('「もう一度試す」は、読み直している間は aria-disabled でフォーカスを残し、状態を status に出し、また失敗したら知らせる', async ({
    page,
  }) => {
    let calls = 0;
    await page.route('**/api/aoba/organization', async (route) => {
      calls += 1;
      if (calls <= 2) {
        // 2回目（最初の「もう一度試す」）は、少し待ってからまた失敗する
        if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 600));
        await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } });
        return;
      }
      await route.continue();
    });
    await page.goto('/aoba');
    await expect(page).toHaveTitle('読み込めませんでした - Scrum Guild');
    const retry = page.getByRole('button', { name: 'もう一度試す' });
    const status = page.locator('.empty [role="status"]');
    await expect(retry).toHaveAttribute('aria-disabled', 'false');
    await expect(status).toHaveText('');

    await retry.click();
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(status).toHaveText('読み込んでいます');
    // 押せない間もフォーカスは残り、押しても読み直しは増えない（Playwright は aria-disabled を待つので force で押す）
    await expect(retry).toBeFocused();
    await retry.click({ force: true });
    // 読み直しが失敗に終わったら、知らせる
    await expect(status).toHaveText('まだ読み込めませんでした');
    await expect(retry).toHaveAttribute('aria-disabled', 'false');
    expect(calls).toBe(2);

    await retry.click();
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  });

  test('組織の外の画面は、テーマと言葉づかいを既定に戻し、覚えたテーマも消す', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.organization.theme = 'medieval';
      body.organization.vocabulary = 'scrum';
    });
    await page.goto('/aoba');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'medieval');
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).toBe('medieval');

    // 見つからない画面（組織の外）
    await page.goto('/hibari');
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドが見つかりません' })).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).toBeNull();
  });

  test('組織の外から組織へ移る間は読み込み中を出し、移ったら組織の値を当てる', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.organization.theme = 'modern';
    });
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [{ slug: 'aoba', name: 'あおば開発' }],
          invitations: [{ organization_name: 'つばめ商会' }],
          operator: false,
        },
      }),
    );
    await page.goto('/');
    await page.route('**/api/aoba/organization', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await page.getByRole('link', { name: /あおば開発/ }).click();
    // 少し遅れて、見出しと題名を持つ読み込み中の表示を出す。読み上げの領域は常に置いてあり、文字だけが替わる
    await expect(page.getByRole('heading', { level: 1, name: '読み込んでいます' })).toBeVisible();
    await expect(page).toHaveTitle('読み込んでいます - Scrum Guild');
    await expect(page.locator('[role="status"].visually-hidden').first()).toHaveText('読み込んでいます');
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  });

  test('読み込み中の表示は、移り始めてから 300ms たつまで出さない', async ({ page }) => {
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [{ slug: 'aoba', name: 'あおば開発' }],
          invitations: [{ organization_name: 'つばめ商会' }],
          operator: false,
        },
      }),
    );
    await page.goto('/');
    // 実際の読み込みの速さは CI で揺れるので、出たかどうかではなく、押してから出るまでの時間を見る
    await page.evaluate(() => {
      const seen: { clickedAt: number | null; shownAt: number | null } = { clickedAt: null, shownAt: null };
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      document.addEventListener('click', () => (seen.clickedAt ??= performance.now()), true);
      new MutationObserver(() => {
        if (seen.shownAt === null && document.body.innerText.includes('しばらくお待ちください')) {
          seen.shownAt = performance.now();
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByRole('link', { name: /あおば開発/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    const seen = await page.evaluate(
      () => (window as unknown as { __seen: { clickedAt: number | null; shownAt: number | null } }).__seen,
    );
    expect(seen.clickedAt).not.toBeNull();
    if (seen.shownAt !== null) expect(seen.shownAt - (seen.clickedAt ?? 0)).toBeGreaterThanOrEqual(300);
  });
});

test.describe('組織が2つの人（あおば開発の管理者でひばり工房の一般のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('/ を開くと組織の選択の画面になり、選ぶとその組織に入る', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドを選ぶ' })).toBeVisible();
    await expect(page.locator('.nav')).toHaveCount(0);
    await expect(page.locator('a.choice')).toHaveText([/あおば開発/, /ひばり工房/]);

    await page.getByRole('link', { name: /あおば開発/ }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('組織を切り替えると、名前、管理者の印、テーマがその組織の値に替わる', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.organization.theme = 'medieval';
      body.me.name = 'ミナト（あおば）';
    });
    await patchOrganization(page, 'hibari', (body) => {
      body.organization.theme = 'modern';
      body.me.name = 'ミナト（ひばり）';
    });
    await page.goto('/aoba');
    await expect(page.locator('.me')).toContainText('ミナト（あおば）');
    await expect(page.locator('.me .chip')).toHaveText('ギルドマスター');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'medieval');

    // 閉じているときは、今の組織の名前だけを出す。開くと各組織へのリンクと、最後に一覧へ戻るリンク
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toContainText('あおば開発');
    await expect(page.locator('.org-menu-list')).toBeHidden();
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(menuLinks(page)).toHaveText(['あおば開発', 'ひばり工房', '冒険者ギルドの一覧へ']);
    await expect(menuLinks(page).nth(0)).toHaveAttribute('aria-current', 'page');
    await expect(menuLinks(page).nth(0).locator('svg')).toHaveCount(1);
    await expect(menuLinks(page).nth(1)).not.toHaveAttribute('aria-current', /.*/);
    // ボタンとリストには、読み上げの名前がある
    await expect(menuButton(page)).toHaveAttribute('aria-label', 'あおば開発。冒険者ギルドを切り替える');
    await expect(page.getByRole('list', { name: '入れる冒険者ギルド' })).toBeVisible();
    await menuLinks(page).nth(1).click();

    await expect(page).toHaveURL(/\/hibari$/);
    await expect(page.locator('.me')).toContainText('ミナト（ひばり）');
    // ひばり工房では一般のユーザーなので、管理者の印は無い
    await expect(page.locator('.me .chip')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'modern');
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).toBe('modern');
    // 選んだら閉じ、今の組織が替わっている
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toContainText('ひばり工房');
  });

  test('切り替えは、フォーカスしただけでは移らず、Enter で移る。Esc で閉じて、ボタンにフォーカスが戻る', async ({
    page,
  }) => {
    await page.goto('/aoba');
    await menuButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(menuLinks(page).nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await expect(menuLinks(page).nth(1)).toBeFocused();
    // フォーカスが当たっただけでは移らない
    await expect(page).toHaveURL(/\/aoba$/);

    await page.keyboard.press('Escape');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/hibari$/);
  });

  test('メニューの外を押すと閉じる', async ({ page }) => {
    await page.goto('/aoba');
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('heading', { level: 1, name: '自分の今日' }).click();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('Tab でメニューの外へ出ると閉じる', async ({ page }) => {
    await page.goto('/aoba');
    await menuButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    // 3つのリンクを通り過ぎて、メニューの外（左のメニューの項目）へ出る
    for (let index = 0; index < 4; index++) await page.keyboard.press('Tab');
    await expect(page.locator('.nav-item').first()).toBeFocused();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('リンクを開いたまま Esc で閉じると、フォーカスはボタンに戻る', async ({ page }) => {
    await page.goto('/aoba');
    await menuButton(page).click();
    await menuLinks(page).nth(1).focus();
    await page.keyboard.press('Escape');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toBeFocused();
  });

  test('組織が多いときは、一覧が画面の高さの 40% までで、中でスクロールする', async ({ page }) => {
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [
            { slug: 'aoba', name: 'あおば開発' },
            ...Array.from({ length: 14 }, (_, index) => ({ slug: `k${index}`, name: `組織${index}` })),
          ],
          invitations: [],
          operator: false,
        },
      }),
    );
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/aoba');
    await menuButton(page).click();
    const list = page.locator('.org-menu-list');
    const sizes = await list.evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
      bottom: element.getBoundingClientRect().bottom,
      inner: window.innerHeight,
    }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    expect(sizes.client).toBeLessThanOrEqual(600 * 0.4 + 2);
    expect(sizes.bottom).toBeLessThanOrEqual(sizes.inner);
  });

  test('1組織でも届いた招待があれば、ボタンに印を出し、一覧へ戻る行に招待が届いていることを添える', async ({
    page,
  }) => {
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [{ slug: 'aoba', name: 'あおば開発' }],
          invitations: [{ organization_name: 'つばめ商会' }],
          operator: false,
        },
      }),
    );
    await page.goto('/aoba');
    await expect(menuButton(page).locator('.chip')).toHaveText('届いた招待あり');
    await expect(menuButton(page)).toHaveAttribute('aria-label', /届いた招待あり/);
    await menuButton(page).click();
    await expect(menuLinks(page)).toHaveCount(2);
    await expect(menuLinks(page).last()).toContainText('招待が届いています');
    await menuLinks(page).last().click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 2, name: '届いた招待' })).toBeVisible();
  });

  test('今の組織の名前は、入れる組織の一覧の名前を使う。一覧に無いときだけ組織の操作の名前を使う', async ({ page }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.organization.name = '操作の名前';
    });
    await page.goto('/aoba');
    await expect(menuButton(page)).toContainText('あおば開発');
    await expect(menuButton(page)).not.toContainText('操作の名前');

    // 一覧に今の組織が無いときだけ、組織の操作の名前を使う
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [{ slug: 'hibari', name: 'ひばり工房' }],
          invitations: [{ organization_name: 'つばめ商会' }],
          operator: false,
        },
      }),
    );
    await page.goto('/aoba');
    await expect(menuButton(page)).toContainText('操作の名前');
  });

  test('別の組織へ移っている間は、ボタンに「移っています」を出す', async ({ page }) => {
    await page.route('**/api/hibari/organization', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.goto('/aoba');
    await menuButton(page).click();
    await menuLinks(page).nth(1).click();
    // リンクを選んだら、移る前に、隠れるリンクではなくボタンにフォーカスを戻して閉じる
    await expect(menuButton(page)).toBeFocused();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toContainText('移っています');
    await expect(page.locator('.org-menu [role="status"]')).toHaveText('移っています');
    await expect(page).toHaveURL(/\/hibari$/);
    await expect(menuButton(page)).toContainText('ひばり工房');
    await expect(page.locator('.org-menu [role="status"]')).toHaveText('');
  });

  test('狭い幅では、一覧のリンクの高さが 44px 以上ある', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/aoba');
    await menuButton(page).click();
    for (const link of await menuLinks(page).all()) {
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('切り替えの最後の項目で、組織の選択の画面に戻る', async ({ page }) => {
    await page.goto('/aoba');
    await menuButton(page).click();
    await menuLinks(page).last().click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドを選ぶ' })).toBeVisible();
  });

  test('390px の幅でも、組織の切り替えが出て、各組織へ移れ、一覧に戻れる', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/aoba');
    await expect(menuButton(page)).toBeVisible();
    await menuButton(page).click();
    await expect(menuLinks(page)).toHaveText(['あおば開発', 'ひばり工房', '冒険者ギルドの一覧へ']);
    for (const link of await menuLinks(page).all()) await expect(link).toBeVisible();
    const closed = await overflowOf(page);
    expect(closed.scroll).toBeLessThanOrEqual(closed.inner);

    await menuLinks(page).nth(1).click();
    await expect(page).toHaveURL(/\/hibari$/);
    await menuButton(page).click();
    await menuLinks(page).last().click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドを選ぶ' })).toBeVisible();
  });

  test('長い組織名、slug、ユーザー名でも、横にはみ出さない', async ({ page }) => {
    const longName = 'とても長い組織の名前'.repeat(10);
    const longSlug = 'a'.repeat(60);
    const longUser = 'ミナトミナトミナト'.repeat(10);
    await page.setViewportSize({ width: 390, height: 800 });

    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [
            { slug: longSlug, name: longName },
            { slug: 'aoba', name: 'あおば開発' },
          ],
          invitations: [{ organization_name: longName }],
          operator: false,
        },
      }),
    );
    await page.goto('/');
    await expect(page.locator('a.choice').first()).toBeVisible();
    const select = await overflowOf(page);
    expect(select.scroll).toBeLessThanOrEqual(select.inner);

    await patchOrganization(page, 'aoba', (body) => {
      body.organization.name = longName;
      body.me.name = longUser;
      body.me.is_admin = true;
    });
    await page.goto('/aoba');
    await expect(page.locator('.me')).toContainText(longUser);
    await menuButton(page).click();
    const shell = await overflowOf(page);
    expect(shell.scroll).toBeLessThanOrEqual(shell.inner);
  });
});

test.describe('ひばり工房だけの管理者（リン）', () => {
  test('/ を開くとひばり工房に入る。あおば開発の slug は見つからない', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'otherOrg');
    await page.goto('/');
    await expect(page).toHaveURL(/\/hibari$/);
    await expect(page.locator('.me')).toContainText('リン');
    await expect(page.locator('.me .chip')).toHaveText('ギルドマスター');

    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドが見つかりません' })).toBeVisible();
  });
});

test.describe('ログインしていない人と、組織が無い人', () => {
  test('ログインしていないと、今のパスを return_to に入れてログインの画面へ移す', async ({ page }) => {
    await page.goto('/aoba');
    await expect(page).toHaveURL(/\/login\?return_to=%2Faoba$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\?return_to=%2F$/);
  });

  test('入れる組織が無い運用者は、運用の画面へ移す', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'operator');
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({ json: { organizations: [], invitations: [], operator: true } }),
    );
    // e2e の Worker には運用者の一覧が無いので、運用の画面が取る組織の一覧も差し替える（e2e/operator.test.ts）
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: [] } }));
    await page.goto('/');
    await expect(page).toHaveURL(/\/operator$/);
    await expect(page.getByRole('heading', { level: 1, name: '運用' })).toBeVisible();
    await expect(page.getByText('運用者のログインで入りました')).toHaveCount(0);
  });

  test('入れる組織が1つでも届いた招待があれば組織の選択の画面を出し、招待は組織の名前だけを出す', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: [{ slug: 'aoba', name: 'あおば開発' }],
          invitations: [{ organization_name: 'つばめ商会' }],
          operator: false,
        },
      }),
    );
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('a.choice')).toHaveText([/あおば開発/]);
    await expect(page.getByRole('heading', { level: 2, name: '届いた招待' })).toBeVisible();
    await expect(page.locator('.choice.is-static')).toContainText('つばめ商会');
    // 届いた招待の行は記録の面（.panel）ではない。.panel は現代風で光るため
    await expect(page.locator('.panel')).toHaveCount(0);
  });

  test('入れる組織は無く、招待だけが届いている人には、招待を承諾する画面がこれから加わることを出す', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({
        json: { organizations: [], invitations: [{ organization_name: 'つばめ商会' }], operator: false },
      }),
    );
    await page.goto('/');
    await expect(page.getByText('まだ入れる冒険者ギルドがありません')).toBeVisible();
    await expect(page.getByText('届いた招待の承諾と辞退は、この画面にこれから加わります。')).toBeVisible();
    await expect(page.getByText('招待が届くと、ここに出ます')).toHaveCount(0);
  });

  test('入れる組織も招待も無い人には、空の状態を出す', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({ json: { organizations: [], invitations: [], operator: false } }),
    );
    await page.goto('/');
    await expect(page.getByText('入れる冒険者ギルドがありません')).toBeVisible();
  });

  test('組織の選択の読み込みに失敗したときは、「読み込めませんでした」と「もう一度試す」を出す', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } }),
    );
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '読み込めませんでした' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'もう一度試す' })).toBeEnabled();
  });

  test('組織の選択の画面は、テーマと言葉づかいを既定に戻す', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await page.addInitScript(() => localStorage.setItem('sg-theme', 'medieval'));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドを選ぶ' })).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).toBeNull();
  });
});
