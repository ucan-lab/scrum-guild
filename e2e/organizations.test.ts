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

// 組織の切り替え（メニューの上の選択）
const switcherOf = (page: Page) => page.locator('.ws-select select');

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
    await expect(switcherOf(page)).toHaveCount(0);
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

  test('ワークスペースがまだない管理者には、最初のワークスペースを作るボタンを出し、メニューは組織の画面だけ', async ({
    page,
  }) => {
    await patchOrganization(page, 'aoba', (body) => {
      body.me.is_admin = true;
      body.workspaces = [];
    });
    await page.goto('/aoba');
    await expect(page.getByText('まだパーティがありません')).toBeVisible();
    const create = page.getByRole('link', { name: 'パーティを作る' });
    await expect(create).toHaveAttribute('href', '/aoba/workspaces/new');
    await expect(page.locator('.nav-group')).toHaveCount(0);
  });

  test('ワークスペースがある人には、作るボタンを出さない', async ({ page }) => {
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'パーティを作る' })).toHaveCount(0);
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

  test('読み込みに失敗したときは、見つからない画面ではなく「もう一度試す」を出す', async ({ page }) => {
    let fail = true;
    await page.route('**/api/aoba/organization', async (route) => {
      if (fail) await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } });
      else await route.continue();
    });
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '読み込めませんでした' })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'もう一度試す' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
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

    const switcher = switcherOf(page);
    await expect(switcher.locator('option')).toHaveText(['あおば開発', 'ひばり工房', '冒険者ギルドの一覧へ']);
    await expect(switcher).toHaveValue('aoba');
    await switcher.selectOption('hibari');

    await expect(page).toHaveURL(/\/hibari$/);
    await expect(page.locator('.me')).toContainText('ミナト（ひばり）');
    // ひばり工房では一般のユーザーなので、管理者の印は無い
    await expect(page.locator('.me .chip')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'modern');
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).toBe('modern');
    await expect(switcherOf(page)).toHaveValue('hibari');
  });

  test('切り替えの最後の項目で、組織の選択の画面に戻る', async ({ page }) => {
    await page.goto('/aoba');
    await switcherOf(page).selectOption({ label: '冒険者ギルドの一覧へ' });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: '冒険者ギルドを選ぶ' })).toBeVisible();
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
    await page.goto('/');
    await expect(page).toHaveURL(/\/operator$/);
    await expect(page.getByRole('heading', { level: 1, name: '運用' })).toBeVisible();
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
    await expect(page.locator('.panel')).toContainText('つばめ商会');
  });

  test('入れる組織も招待も無い人には、空の状態を出す', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    await page.route('**/api/my-organizations', (route) =>
      route.fulfill({ json: { organizations: [], invitations: [], operator: false } }),
    );
    await page.goto('/');
    await expect(page.getByText('入れる冒険者ギルドがありません')).toBeVisible();
  });
});
