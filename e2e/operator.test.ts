// 運用の画面（組織の一覧と、組織の作成のダイアログ）。seed のセッション（seed/sessions.ts）の Cookie で開く。
// e2e の Worker には運用者の一覧（シークレット OPERATOR_LOGIN_IDS）が無く、本物の GitHub へも行かないので、運用者の操作
// （組織の一覧、ユーザー名の解決、組織の作成）の応答は差し替える。サーバーの処理は test/operator-organizations.test.ts、
// 運用者でない人の扱い（403、/ への戻し）は本物のサーバーで確かめる
import { expect, test, type Page } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

// 1x1 の PNG
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

type ListedOrganization = {
  slug: string;
  name: string;
  suspended_at: string | null;
  created_at: string;
  admin_status: 'none' | 'pending' | 'active';
};

const organization = (overrides: Partial<ListedOrganization>): ListedOrganization => ({
  slug: 'aoba',
  name: 'あおば開発',
  suspended_at: null,
  created_at: '2026-10-01T09:30:00.000Z',
  admin_status: 'active',
  ...overrides,
});

function invalidInput(path: string, code: string) {
  return {
    status: 400,
    json: { error: { code: 'invalid_input', message: 'x', details: [{ path, code, message: 'x' }] } },
  };
}

async function mockList(page: Page, organizations: ListedOrganization[]) {
  await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations } }));
}

async function mockGithubUser(page: Page, user: Record<string, unknown> | { status: number; json: unknown }) {
  // 後から足した差し替えが先に効く
  await page.route('**/api/resolve-github-user', (route) =>
    route.fulfill('status' in user ? { status: user.status as number, json: user.json } : { json: user }),
  );
}

test.describe('運用者', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'operator');
  });

  test('組織の一覧に、名前、slug、停止、管理者の状態の印を出す', async ({ page }) => {
    await mockList(page, [
      organization({}),
      organization({ slug: 'hibari', name: 'ひばり工房', admin_status: 'none' }),
      organization({ slug: 'tsubame', name: 'つばめ商会', admin_status: 'pending' }),
      organization({ slug: 'kamome', name: 'かもめ社', suspended_at: '2026-10-10T00:00:00.000Z' }),
    ]);
    const collect = await watchViolations(page);
    await page.goto('/operator');
    await expect(page.getByRole('heading', { level: 1, name: '運用' })).toBeVisible();
    const rows = page.locator('.table tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: 'あおば開発' })).toContainText('aoba');
    await expect(rows.filter({ hasText: 'あおば開発' }).locator('.chip')).toHaveCount(0);
    await expect(rows.filter({ hasText: 'ひばり工房' }).locator('.chip.is-danger')).toHaveText(
      'ギルドマスターがいない',
    );
    await expect(rows.filter({ hasText: 'つばめ商会' }).locator('.chip.is-warn')).toHaveText(
      'ギルドマスターはログイン待ち',
    );
    await expect(rows.filter({ hasText: 'かもめ社' }).locator('.chip.is-warn')).toHaveText('停止中');
    await expect(rows.filter({ hasText: 'あおば開発' }).locator('.mono').last()).toHaveText('2026-10-01 09:30');
    expect(await collect()).toEqual([]);
  });

  test('組織が無いときは、作る案内を出す', async ({ page }) => {
    await mockList(page, []);
    await page.goto('/operator');
    await expect(page.getByText('冒険者ギルドがまだありません')).toBeVisible();
    await expect(page.locator('.table')).toHaveCount(0);
  });

  test('作成のダイアログで、ユーザー名を解決して人を確かめてから作り、完了の表示に URL が出て、一覧が読み直される', async ({
    page,
  }) => {
    const listed = [organization({})];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    // GitHub のアバターのホストへは出ず、画像を差し替える
    await page.route('https://avatars.githubusercontent.com/**', (route) =>
      route.fulfill({ body: PIXEL, contentType: 'image/png' }),
    );
    await mockGithubUser(page, {
      login_subject: '5550001',
      login_name: 'kotone-dev',
      display_name: '星野 琴音',
      avatar_url: 'https://avatars.githubusercontent.com/u/5550001',
    });
    let created: unknown;
    await page.route('**/api/create-organization', async (route) => {
      created = route.request().postDataJSON();
      listed.push(organization({ slug: 'sakura-dev', name: 'さくら開発', admin_status: 'pending' }));
      await route.fulfill({ json: { slug: 'sakura-dev', name: 'さくら開発', admin_login_name: 'kotone-dev' } });
    });

    const collect = await watchViolations(page);
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    // 完了の表示では題名が替わるので、名前では絞らない
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '冒険者ギルドを作る' })).toBeVisible();

    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('さくら開発');
    // 確かめるまでは作れない
    const submit = dialog.getByRole('button', { name: '作る', exact: true });
    await expect(submit).toBeDisabled();

    await dialog.getByLabel('GitHub のユーザー名').fill('kotone-dev');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(dialog.getByText('星野 琴音')).toBeVisible();
    await expect(dialog.locator('.choice .mono')).toHaveText('kotone-dev');
    await expect(dialog.locator('.choice img')).toBeVisible();
    // 画像が読み込めている（CSP に止められていない）
    expect(await dialog.locator('.choice img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(
      0,
    );
    await expect(submit).toBeEnabled();

    // ユーザー名を直したら、確かめた結果は捨てて、もう一度確かめるまで作れない
    await dialog.getByLabel('GitHub のユーザー名').fill('kotone-dev2');
    await expect(dialog.getByText('星野 琴音')).toHaveCount(0);
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('GitHub のユーザー名').fill('kotone-dev');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(submit).toBeEnabled();

    await submit.click();
    // 完了の表示: 組織の URL とコピー、伝えること
    await expect(dialog.getByRole('heading', { name: '冒険者ギルドを作りました' })).toBeVisible();
    await expect(dialog.getByLabel('冒険者ギルドの URL')).toHaveValue(/\/sakura-dev\/$/);
    await expect(dialog.getByRole('button', { name: 'コピー' })).toBeVisible();
    await expect(dialog.getByText('GitHub の kotone-dev でログインするよう伝えてください。')).toBeVisible();
    expect(created).toEqual({
      slug: 'sakura-dev',
      name: 'さくら開発',
      admin: { provider: 'github', username: 'kotone-dev', login_subject: '5550001' },
    });
    expect(await collect()).toEqual([]);

    await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
    await expect(dialog).toBeHidden();
    // 一覧が読み直され、指名した人のログイン待ちの印が付く
    const row = page.locator('.table tbody tr').filter({ hasText: 'さくら開発' });
    await expect(row).toContainText('sakura-dev');
    await expect(row.locator('.chip.is-warn')).toHaveText('ギルドマスターはログイン待ち');
  });

  test('組織のアカウントや、いないユーザー名は、理由を出して確かめた結果にしない', async ({ page }) => {
    await mockList(page, []);
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');

    await mockGithubUser(page, invalidInput('username', 'github_not_a_user'));
    await dialog.getByLabel('GitHub のユーザー名').fill('github');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(dialog.getByRole('alert')).toContainText('個人のアカウントではありません');
    await expect(dialog.getByRole('button', { name: '作る', exact: true })).toBeDisabled();

    await mockGithubUser(page, invalidInput('username', 'github_user_not_found'));
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(dialog.getByRole('alert')).toContainText('そのユーザー名の人が GitHub にいません');

    // 届かないときは、入力の誤りと分けて知らせる
    await mockGithubUser(page, { status: 503, json: { error: { code: 'unavailable', message: 'x' } } });
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(dialog.getByRole('alert')).toContainText('GitHub に届きませんでした');
  });

  test('予約した名前と形の合わない slug は、作る前に欄の下で知らせる', async ({ page }) => {
    await mockList(page, []);
    await mockGithubUser(page, {
      login_subject: '5550002',
      login_name: 'rin-dev',
      display_name: null,
      avatar_url: null,
    });
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('rin-dev');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(dialog.getByText('表示名なし')).toBeVisible();

    await dialog.getByLabel('URL の名前（slug）').fill('operator');
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('アプリが使うので付けられません');

    await dialog.getByLabel('URL の名前（slug）').fill('Bad_Name');
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('英小文字、数字、ハイフンで 2〜40 字');
  });

  test('重なる slug は、サーバーの 409 を欄の下で知らせる', async ({ page }) => {
    await mockList(page, []);
    await mockGithubUser(page, {
      login_subject: '5550003',
      login_name: 'rin-dev',
      display_name: 'リン',
      avatar_url: null,
    });
    await page.route('**/api/create-organization', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x' } } }),
    );
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('aoba');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('rin-dev');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('この slug はもう使われています');
  });

  test('Google を選ぶと、まだ使えないと出して作れない', async ({ page }) => {
    await mockList(page, []);
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'Google' }).check();
    await expect(dialog.getByText('Google での指名はまだ使えません')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '作る', exact: true })).toBeDisabled();
  });
});

test('運用者でない人が /operator を開くと、/ に戻る（組織が1つの人は組織の画面に入る）', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/operator');
  await expect(page).toHaveURL(/\/aoba$/);
});

test('運用者でない人は、運用者の操作を呼ぶと 403', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  for (const name of ['list-organizations', 'resolve-github-user', 'create-organization']) {
    const res = await page.request.post(`/api/${name}`, {
      headers: { Origin: baseURL ?? '', 'Content-Type': 'application/json' },
      data: {},
    });
    expect(res.status(), name).toBe(403);
  }
});

test('ログインしていない人が /operator を開くと、ログインの画面に移る', async ({ page }) => {
  await page.goto('/operator');
  await expect(page).toHaveURL(/\/login\?return_to=%2Foperator/);
});
