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

// 応答を保留して、あとで返す。遅れて届く応答を作る
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release };
}

const TOKYO_USER = {
  login_subject: '5550010',
  login_name: 'alice-dev',
  display_name: 'アリス',
  avatar_url: null,
};

test.describe('運用者', () => {
  // 作った日時はブラウザのタイムゾーンで出す
  test.use({ timezoneId: 'Asia/Tokyo' });

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
    // 2026-10-01T09:30Z は、東京のブラウザでは 18:30
    await expect(rows.filter({ hasText: 'あおば開発' }).locator('.mono').last()).toHaveText('2026/10/01 18:30');
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

  test('確かめている最中にユーザー名を直すと、遅れて届いた古い応答では確かめた結果にならず、作れない', async ({
    page,
  }) => {
    await mockList(page, []);
    const alice = deferred<void>();
    await page.route('**/api/resolve-github-user', async (route) => {
      if (route.request().postDataJSON().username === 'alice') await alice.promise;
      await route.fulfill({ json: TOKYO_USER });
    });
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(dialog.getByRole('button', { name: '確かめています' })).toBeVisible();

    // 確かめている最中に bob へ直す。確かめる操作も、もう一度押せる
    await dialog.getByLabel('GitHub のユーザー名').fill('bob');
    await expect(dialog.getByRole('button', { name: '確かめる' })).toBeVisible();
    alice.release();
    // 古い alice の応答が処理される時間を置いても、確かめた人は出ず、作れない
    await page.waitForTimeout(300);
    await expect(dialog.locator('.choice')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '作る', exact: true })).toBeDisabled();
  });

  test('確かめている最中に閉じて開き直すと、古い応答は新しいダイアログに入らない', async ({ page }) => {
    await mockList(page, []);
    const pending = deferred<void>();
    await page.route('**/api/resolve-github-user', async (route) => {
      await pending.promise;
      await route.fulfill({ json: TOKYO_USER });
    });
    await page.goto('/operator');
    const open = page.getByRole('button', { name: '冒険者ギルドを作る' });
    await open.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();

    await open.click();
    await expect(dialog.getByLabel('GitHub のユーザー名')).toHaveValue('');
    pending.release();
    await page.waitForTimeout(300);
    await expect(dialog.locator('.choice')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '作る', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '確かめる' })).toBeVisible();
  });

  test('作っている最中に閉じて開き直すと、前の完了の表示は残らない', async ({ page }) => {
    await mockList(page, []);
    await mockGithubUser(page, TOKYO_USER);
    const pending = deferred<void>();
    await page.route('**/api/create-organization', async (route) => {
      await pending.promise;
      await route.fulfill({ json: { slug: 'sakura-dev', name: '工房', admin_login_name: 'alice-dev' } });
    });
    await page.goto('/operator');
    const open = page.getByRole('button', { name: '冒険者ギルドを作る' });
    await open.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '作っています' })).toBeVisible();
    // 作っている最中に閉じる（Esc）と、開き直す
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await open.click();
    pending.release();
    await page.waitForTimeout(300);
    await expect(dialog.getByRole('heading', { name: '冒険者ギルドを作る' })).toBeVisible();
    await expect(dialog.getByLabel('冒険者ギルドの URL')).toHaveCount(0);
    await expect(dialog.getByLabel('URL の名前（slug）')).toHaveValue('');
  });

  test('作った後に一覧の読み直しが失敗しても、完了の表示（組織の URL）は消えない', async ({ page }) => {
    let reads = 0;
    await page.route('**/api/list-organizations', (route) =>
      ++reads === 1
        ? route.fulfill({ json: { organizations: [] } })
        : route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await mockGithubUser(page, TOKYO_USER);
    await page.route('**/api/create-organization', (route) =>
      route.fulfill({ json: { slug: 'sakura-dev', name: '工房', admin_login_name: 'alice-dev' } }),
    );
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog.getByLabel('冒険者ギルドの URL')).toHaveValue(/\/sakura-dev\/$/);
    // 一覧の読み直しは失敗して、画面の裏は読み込みの失敗になるが、ダイアログは残る
    await expect.poll(() => reads).toBeGreaterThan(1);
    await page.waitForTimeout(300);
    await expect(dialog.getByLabel('冒険者ギルドの URL')).toHaveValue(/\/sakura-dev\/$/);
    await expect(dialog.getByText('GitHub の alice-dev でログインするよう伝えてください。')).toBeVisible();
  });

  test('サーバーの失敗は、辞書に無い 400 も、通信の切れも、5xx も、それぞれ別の文言で出す', async ({ page }) => {
    await mockList(page, []);
    await mockGithubUser(page, TOKYO_USER);
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    const submit = dialog.getByRole('button', { name: '作る', exact: true });

    // 辞書に無い理由の 400 は「届きませんでした」にしない
    await page.route('**/api/create-organization', (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: { code: 'invalid_input', message: 'x', details: [{ path: 'x', code: 'unknown_code', message: 'x' }] },
        },
      }),
    );
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('入力に誤りがあります');
    await expect(dialog.getByRole('alert')).not.toContainText('届きません');

    // 5xx と通信の切れは、サーバーで作られていることがあるので、一覧を確かめるよう伝える
    await page.route('**/api/create-organization', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('一覧を確かめてから');
    await page.route('**/api/create-organization', (route) => route.abort('connectionreset'));
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('一覧を確かめてから');

    // slug の 409 には、自分が作った組織かもしれないことを添える
    await page.route('**/api/create-organization', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x' } } }),
    );
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('今作った冒険者ギルドかもしれない');
  });

  test('入力欄の長さの上限と、誤りのある欄へのフォーカス、読み上げとの結び付き', async ({ page }) => {
    await mockList(page, []);
    await mockGithubUser(page, { status: 400, json: invalidInput('username', 'github_user_not_found').json });
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    const slug = dialog.getByLabel('URL の名前（slug）');
    await slug.fill('a'.repeat(60));
    expect(await slug.inputValue()).toHaveLength(40);
    const name = dialog.getByLabel('表示名');
    await name.fill('あ'.repeat(120));
    expect(await name.inputValue()).toHaveLength(80);
    const username = dialog.getByLabel('GitHub のユーザー名');
    await username.fill('b'.repeat(60));
    expect(await username.inputValue()).toHaveLength(39);

    // 確かめて失敗すると、ユーザー名の欄にフォーカスが移り、aria-describedby に誤りとヒントの id が入る
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(username).toBeFocused();
    await expect(username).toHaveAttribute('aria-invalid', 'true');
    const describedBy = (await username.getAttribute('aria-describedby')) ?? '';
    expect(describedBy.split(' ')).toEqual(['operator-username-error', 'operator-username-hint']);
    await expect(page.locator('#operator-username-error')).toContainText('GitHub にいません');
    await expect(page.locator('#operator-username-hint')).toBeVisible();

    // 作る前の確かめ（slug の形）で、誤りのある最初の欄へフォーカスが移る
    await mockGithubUser(page, TOKYO_USER);
    await username.fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await slug.fill('Bad_Name');
    await name.fill('');
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(slug).toBeFocused();
    expect((await slug.getAttribute('aria-describedby'))?.split(' ')).toEqual([
      'operator-slug-error',
      'operator-slug-hint',
    ]);
    await expect(name).toHaveAttribute('aria-invalid', 'true');
  });

  test('狭い幅でも、確かめるボタンは入力欄の横に残り、ヒントやエラーの横に落ちない', async ({ page }) => {
    await mockList(page, []);
    await mockGithubUser(page, { status: 400, json: invalidInput('username', 'github_not_a_user').json });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('GitHub のユーザー名').fill('github');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    const input = (await dialog.getByLabel('GitHub のユーザー名').boundingBox())!;
    const button = (await dialog.getByRole('button', { name: '確かめる' }).boundingBox())!;
    const error = (await dialog.getByRole('alert').boundingBox())!;
    // ボタンの縦の中心が入力欄の高さの中にあり、エラーは入力欄より下にある
    const center = button.y + button.height / 2;
    expect(center).toBeGreaterThanOrEqual(input.y);
    expect(center).toBeLessThanOrEqual(input.y + input.height);
    expect(error.y).toBeGreaterThan(input.y + input.height - 1);
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
