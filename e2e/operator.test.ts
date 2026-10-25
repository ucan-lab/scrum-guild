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
  purge_on: string | null;
  created_at: string;
  admin_status: 'none' | 'pending' | 'expired' | 'active';
};

const organization = (overrides: Partial<ListedOrganization>): ListedOrganization => ({
  slug: 'aoba',
  name: 'あおば開発',
  suspended_at: null,
  purge_on: null,
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

// 保留した応答を返し、画面がそれを処理し終えるまで待つ（時間では待たない）。
// 応答が届いたら、続けて 2 フレーム待つ（応答の本文の読み取りと、その後の状態の更新と描画が済む）
async function settleAfterResponse(page: Page, urlPart: string, release: () => void) {
  const response = page.waitForResponse((res) => res.url().includes(urlPart));
  release();
  await response;
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
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
      organization({
        slug: 'ibis',
        name: 'とき運送',
        suspended_at: '2026-10-11T00:00:00.000Z',
        purge_on: '2026-11-10',
      }),
    ]);
    const collect = await watchViolations(page);
    await page.goto('/operator');
    await expect(page.getByRole('heading', { level: 1, name: '運用' })).toBeVisible();
    const rows = page.locator('.table tbody tr');
    await expect(rows).toHaveCount(5);
    await expect(rows.filter({ hasText: 'あおば開発' })).toContainText('aoba');
    await expect(rows.filter({ hasText: 'あおば開発' }).locator('.chip')).toHaveCount(0);
    await expect(rows.filter({ hasText: 'ひばり工房' }).locator('.chip.is-danger')).toHaveText(
      'ギルドマスターがいない',
    );
    await expect(rows.filter({ hasText: 'つばめ商会' }).locator('.chip.is-warn')).toHaveText(
      'ギルドマスターは指名済み、ログイン待ち',
    );
    // 停止した日はブラウザのタイムゾーンの日付。一時的な停止には、消す予定日の印を付けない
    await expect(rows.filter({ hasText: 'かもめ社' }).locator('.chip.is-warn')).toHaveText('停止 2026-10-10');
    await expect(rows.filter({ hasText: 'かもめ社' }).locator('.chip.is-danger')).toHaveCount(0);
    // 解約には、消す予定日の印も付く
    await expect(rows.filter({ hasText: 'とき運送' }).locator('.chip.is-warn')).toHaveText('停止 2026-10-11');
    await expect(rows.filter({ hasText: 'とき運送' }).locator('.chip.is-danger')).toHaveText('2026-11-10 に消す');
    // 操作のボタンは、停止していない組織は「停止する」（is-danger）、停止中の組織は「再開する」
    await expect(rows.filter({ hasText: 'あおば開発' }).getByRole('button')).toHaveText('停止する');
    await expect(rows.filter({ hasText: 'あおば開発' }).getByRole('button')).toHaveClass(/is-danger/);
    await expect(rows.filter({ hasText: 'かもめ社' }).getByRole('button')).toHaveText('再開する');
    await expect(rows.filter({ hasText: 'かもめ社' }).getByRole('button')).not.toHaveClass(/is-danger/);
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
      await route.fulfill({
        json: {
          slug: 'sakura-dev',
          name: 'さくら開発',
          admin_login_name: 'kotone-dev',
          invite: null,
        },
      });
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
    await expect(row.locator('.chip.is-warn')).toHaveText('ギルドマスターは指名済み、ログイン待ち');
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
    // 古い alice の応答が届き、画面が処理し終えても、確かめた人は出ず、作れない
    await settleAfterResponse(page, 'resolve-github-user', alice.release);
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
    await settleAfterResponse(page, 'resolve-github-user', pending.release);
    await expect(dialog.locator('.choice')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '作る', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '確かめる' })).toBeVisible();
  });

  test('作っている間は、入力欄と手段が読み取り専用になり、閉じる操作と「作る」を無視し、作り終えると完了の表示に移る', async ({
    page,
  }) => {
    await mockList(page, []);
    await mockGithubUser(page, TOKYO_USER);
    const pending = deferred<void>();
    await page.route('**/api/create-organization', async (route) => {
      await pending.promise;
      await route.fulfill({ json: { slug: 'sakura-dev', name: '工房', admin_login_name: 'alice-dev' } });
    });
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    const submit = dialog.getByRole('button', { name: '作る', exact: true });
    await submit.focus();
    await submit.click();
    const creating = dialog.getByRole('button', { name: '作っています' });
    await expect(creating).toBeVisible();
    // 「作る」は aria-disabled で、フォーカスを落とさず、押しても何も起きない
    await expect(creating).toHaveAttribute('aria-disabled', 'true');
    await expect(creating).toBeFocused();
    await expect(dialog.getByRole('status')).toHaveText('作っています');
    await expect(dialog.getByLabel('URL の名前（slug）')).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('表示名')).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('GitHub のユーザー名')).toHaveAttribute('readonly', '');
    await expect(dialog.getByRole('radio', { name: 'Google' })).toBeDisabled();
    // 閉じる操作（Esc、×、やめる）は無視する
    await page.keyboard.press('Escape');
    // aria-disabled の要素は、Playwright が押せないものとして待つので、force で押す（押しても何も起きないことを確かめる）
    await dialog.getByRole('button', { name: '閉じる', exact: true }).first().click({ force: true });
    await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
    await expect(dialog).toBeVisible();

    await settleAfterResponse(page, 'create-organization', pending.release);
    await expect(dialog.getByRole('heading', { name: '冒険者ギルドを作りました' })).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveText('作りました');
    // フォーカスは完了の表示の本文に移る
    await expect(dialog.locator('p[tabindex="-1"]')).toBeFocused();
  });

  // 管理者がダイアログで確かめた人だとは限らないので、作られていた組織の表示は、人の名前を出さず、一覧の状態だけを出す
  for (const [status, text] of [
    ['active', 'ギルドマスターは、もうログインしています。'],
    ['pending', '指名されたギルドマスターは、まだログインしていません。'],
    ['none', '最初のギルドマスターが書かれていません'],
  ] as const) {
    test(`作れたか分からない失敗の後は一覧を読み直し、同じ slug の組織（管理者の状態 ${status}）があれば、ダイアログの中で示し、URL と状態だけの表示へ移せる`, async ({
      page,
    }) => {
      await expectExistingOrganization(page, status, text);
    });
  }

  async function expectExistingOrganization(page: Page, status: 'active' | 'pending' | 'none', text: string) {
    let created = false;
    await page.route('**/api/list-organizations', (route) =>
      route.fulfill({
        json: {
          organizations: created ? [organization({ slug: 'sakura-dev', name: '工房', admin_status: status })] : [],
        },
      }),
    );
    await mockGithubUser(page, TOKYO_USER);
    await page.route('**/api/create-organization', (route) => {
      // サーバーでは作られたが、応答が 502 で返る
      created = true;
      return route.fulfill({ status: 502, body: 'bad gateway', contentType: 'text/plain' });
    });
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await dialog.getByRole('button', { name: '作る', exact: true }).click();

    await expect(dialog.getByText('「sakura-dev」の冒険者ギルドはもう作られています。名前も入力と同じ')).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('このダイアログを閉じると入力は消えます');
    // 失敗の枠にフォーカスが移っている
    await expect(dialog.locator('.callout.is-danger')).toBeFocused();

    await dialog.getByRole('button', { name: '作られた冒険者ギルドの URL を見る' }).click();
    await expect(dialog.getByRole('heading', { name: '冒険者ギルドはもう作られています' })).toBeVisible();
    await expect(dialog.getByLabel('冒険者ギルドの URL')).toHaveValue(/\/sakura-dev\/$/);
    await expect(dialog.getByRole('status')).toHaveText('作られていた冒険者ギルドを見ています');
    await expect(dialog.getByText(text)).toBeVisible();
    // 確かめた人（alice-dev）の名前で、ログインするよう伝えない
    await expect(dialog.getByText('でログインするよう伝えてください')).toHaveCount(0);
    await expect(dialog).not.toContainText('alice-dev');
  }

  test('slug の 409 も一覧を読み直す。名前が違う組織なら、この入力で作ったものではないかもしれないと出し、完了の表示へは移せない', async ({
    page,
  }) => {
    await mockList(page, [organization({ slug: 'sakura-dev', name: '別の工房', admin_status: 'none' })]);
    await mockGithubUser(page, TOKYO_USER);
    await page.route('**/api/create-organization', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x' } } }),
    );
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('工房');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog.getByText('名前が入力と違うので')).toBeVisible();
    await expect(dialog.getByText('最初のギルドマスターが書かれていません')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '作られた冒険者ギルドの URL を見る' })).toHaveCount(0);
    // slug の欄にフォーカスが移っている
    await expect(dialog.getByLabel('URL の名前（slug）')).toBeFocused();
  });

  test('読み上げの領域は常にあり、確かめている間と確かめた後で文字だけが替わる', async ({ page }) => {
    await mockList(page, []);
    const pending = deferred<void>();
    await page.route('**/api/resolve-github-user', async (route) => {
      await pending.promise;
      await route.fulfill({ json: TOKYO_USER });
    });
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    const status = dialog.getByRole('status');
    await expect(status).toHaveText('');
    await dialog.getByLabel('GitHub のユーザー名').fill('alice');
    await dialog.getByRole('button', { name: '確かめる' }).click();
    await expect(status).toHaveText('確かめています');
    pending.release();
    await expect(status).toHaveText('確かめました: alice-dev');
    // 後から挿入した role="status" の領域は無い（領域は1つだけ）
    await expect(dialog.getByRole('status')).toHaveCount(1);
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
    await expect(page.locator('.gate-title')).toHaveText('読み込めませんでした');
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
    // slug は貼り付けで黙って切らない（切ると別の slug で作られる）。長すぎれば作る前の確かめで断る
    expect(await slug.inputValue()).toHaveLength(60);
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

    // 長すぎる slug は、切らずに断る
    await slug.fill('a'.repeat(60));
    await name.fill('工房');
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(page.locator('#operator-slug-error')).toContainText('2〜40 字');
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

  test('Google を選ぶと、メールアドレスの欄が出る。確かめる手順は無く、入れると作れる', async ({ page }) => {
    await mockList(page, []);
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'Google' }).check();
    await expect(dialog.getByLabel('Google のメールアドレス')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '確かめる' })).toHaveCount(0);
    const submit = dialog.getByRole('button', { name: '作る', exact: true });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('Google のメールアドレス').fill('mio.hoshino@example.com');
    await expect(submit).toBeEnabled();
  });

  test('Google で指名すると、完了の表示に招待の URL とコピー、閉じると二度と出ないことと期限が出て、閉じると消える', async ({
    page,
  }) => {
    const listed = [organization({})];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    const inviteUrl = `http://localhost:8787/invite#${'Qm7tX2vLr9aKpE4wZc8hN3bYd6fGs1uJ0oTiRl5eWxA'}`;
    let created: unknown;
    await page.route('**/api/create-organization', async (route) => {
      created = route.request().postDataJSON();
      listed.push(organization({ slug: 'sakura-dev', name: 'さくら開発', admin_status: 'pending' }));
      await route.fulfill({
        json: {
          slug: 'sakura-dev',
          name: 'さくら開発',
          admin_login_name: 'mio.hoshino@example.com',
          invite: { url: inviteUrl, expires_at: '2026-11-09T00:00:00.000Z' },
        },
      });
    });
    const collect = await watchViolations(page);
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('さくら開発');
    await dialog.getByRole('radio', { name: 'Google' }).check();
    await dialog.getByLabel('Google のメールアドレス').fill(' Mio.Hoshino@Example.com ');
    await dialog.getByRole('button', { name: '作る', exact: true }).click();

    await expect(dialog.getByRole('heading', { name: '冒険者ギルドを作りました' })).toBeVisible();
    await expect(dialog.getByLabel('招待の URL')).toHaveValue(inviteUrl);
    await expect(dialog.getByRole('button', { name: 'コピー' })).toBeVisible();
    await expect(
      dialog.getByText('次のメールアドレスの Google アカウントでログインするよう伝えてください。'),
    ).toBeVisible();
    // メールアドレスは等幅で、狭い幅では折り返す
    const email = dialog.locator('b.mono.wrap-anywhere');
    await expect(email).toHaveText('mio.hoshino@example.com');
    await expect(dialog.getByText('この画面を閉じると二度と出せません')).toBeVisible();
    await expect(dialog.getByText('期限までに本人へ伝えてください')).toBeVisible();
    // まだ無い操作（指名し直し）は勧めない
    await expect(dialog).not.toContainText('指名し直');
    await expect(dialog.getByText('期限は14日（2026/11/09 09:00 まで）')).toBeVisible();
    // メールアドレスは前後の空白を除いて送る（大文字小文字はサーバーがそろえる）
    expect(created).toEqual({
      slug: 'sakura-dev',
      name: 'さくら開発',
      admin: { provider: 'google', email: 'Mio.Hoshino@Example.com' },
    });
    expect(await collect()).toEqual([]);

    await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
    await expect(dialog).toBeHidden();
    // 開き直しても、招待の URL は二度と出ない
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    await expect(page.getByRole('dialog').getByLabel('招待の URL')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Qm7tX2vLr9aKpE4wZc8hN3bYd6fGs1uJ0oTiRl5eWxA');
    await page.getByRole('dialog').locator('.dialog-foot').getByRole('button', { name: 'やめる' }).click();
    // 一覧には、指名済み、ログイン待ちの印が付く
    const row = page.locator('.table tbody tr').filter({ hasText: 'さくら開発' });
    await expect(row.locator('.chip.is-warn')).toHaveText('ギルドマスターは指名済み、ログイン待ち');
  });

  test('メールアドレスの形が合わないという応答は、メールアドレスの欄の下で知らせる', async ({ page }) => {
    await mockList(page, []);
    await page.route('**/api/create-organization', (route) =>
      route.fulfill(invalidInput('admin.email', 'email_invalid')),
    );
    await page.goto('/operator');
    await page.getByRole('button', { name: '冒険者ギルドを作る' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('URL の名前（slug）').fill('sakura-dev');
    await dialog.getByLabel('表示名').fill('さくら開発');
    await dialog.getByRole('radio', { name: 'Google' }).check();
    await dialog.getByLabel('Google のメールアドレス').fill('みお@example.com');
    await dialog.getByRole('button', { name: '作る', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('メールアドレスの形に合いません');
    await expect(dialog.getByLabel('Google のメールアドレス')).toBeFocused();
  });

  test('組織の一覧に、期限が切れた指名の印を出す', async ({ page }) => {
    await mockList(page, [organization({ slug: 'kamome', name: 'かもめ社', admin_status: 'expired' })]);
    await page.goto('/operator');
    await expect(page.locator('.table tbody tr').filter({ hasText: 'かもめ社' }).locator('.chip.is-danger')).toHaveText(
      'ギルドマスターの招待の URL は期限切れ',
    );
  });

  test('「停止する」は確認のダイアログで理由を選んで送り、一覧が読み直されて停止と消す予定日の印が出る', async ({
    page,
  }) => {
    const listed = [organization({}), organization({ slug: 'hibari', name: 'ひばり工房' })];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    let sent: unknown;
    await page.route('**/api/organization-suspend', async (route) => {
      sent = route.request().postDataJSON();
      listed[1] = organization({
        slug: 'hibari',
        name: 'ひばり工房',
        suspended_at: '2026-10-26T00:00:00.000Z',
        purge_on: '2026-11-25',
      });
      await route.fulfill({
        json: { slug: 'hibari', suspended_at: '2026-10-26T00:00:00.000Z', purge_on: '2026-11-25' },
      });
    });
    const collect = await watchViolations(page);
    await page.goto('/operator');
    const row = page.locator('.table tbody tr', { hasText: 'ひばり工房' });
    const button = row.getByRole('button', { name: '「ひばり工房」を停止する' });
    await button.click();

    // 危険の色の確認。理由は既定が「一時的に止める」。取り消せば何も送らない
    const dialog = page.getByRole('dialog', { name: '冒険者ギルドを停止する' });
    await expect(page.locator('.dialog-sheet.is-danger')).toBeVisible();
    await expect(dialog).toContainText('「ひばり工房」を停止します');
    await expect(dialog).not.toContainText('{');
    await expect(dialog.getByRole('radio', { name: /一時的に止める/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    expect(sent).toBeUndefined();

    await button.click();
    await dialog.getByRole('radio', { name: /解約/ }).check();
    await dialog.getByRole('button', { name: '「ひばり工房」を停止する' }).click();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual({ slug: 'hibari', kind: 'cancellation' });

    await expect(page.getByRole('status').filter({ hasText: '冒険者ギルドを停止しました' })).toBeVisible();
    await expect(row.locator('.chip.is-warn')).toHaveText('停止 2026-10-26');
    await expect(row.locator('.chip.is-danger')).toHaveText('2026-11-25 に消す');
    await expect(row.getByRole('button')).toHaveText('再開する');
    // もう一方の組織は変わらない
    await expect(page.locator('.table tbody tr', { hasText: 'あおば開発' }).locator('.chip')).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('「再開する」は確認なしで送り、一覧が読み直されて印が消える', async ({ page }) => {
    const listed = [
      organization({
        slug: 'hibari',
        name: 'ひばり工房',
        suspended_at: '2026-10-10T00:00:00.000Z',
        purge_on: '2026-11-09',
      }),
    ];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    let sent: unknown;
    await page.route('**/api/organization-resume', async (route) => {
      sent = route.request().postDataJSON();
      listed[0] = organization({ slug: 'hibari', name: 'ひばり工房' });
      await route.fulfill({ json: { slug: 'hibari' } });
    });
    await page.goto('/operator');
    const row = page.locator('.table tbody tr', { hasText: 'ひばり工房' });
    await expect(row.locator('.chip')).toHaveCount(2);
    await row.getByRole('button', { name: '「ひばり工房」を再開する' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(sent).toEqual({ slug: 'hibari' });
    await expect(page.getByRole('status').filter({ hasText: '冒険者ギルドを再開しました' })).toBeVisible();
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(row.getByRole('button')).toHaveText('停止する');
  });

  test('停止を送っている間は、「停止する」を押しても無視し、ダイアログも閉じられず、1回しか送らない', async ({
    page,
  }) => {
    const listed = [organization({})];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    let requests = 0;
    const gate = deferred<void>();
    await page.route('**/api/organization-suspend', async (route) => {
      requests++;
      await gate.promise;
      listed[0] = organization({ suspended_at: '2026-10-26T00:00:00.000Z' });
      await route.fulfill({ json: { slug: 'aoba', suspended_at: '2026-10-26T00:00:00.000Z', purge_on: null } });
    });
    await page.goto('/operator');
    await page.getByRole('button', { name: '「あおば開発」を停止する' }).click();
    const dialog = page.getByRole('dialog', { name: '冒険者ギルドを停止する' });
    await dialog.getByRole('button', { name: '「あおば開発」を停止する' }).click();

    const submitting = dialog.getByRole('button', { name: '停止しています' });
    await expect(submitting).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('status')).toHaveText('停止しています');
    await submitting.click({ force: true });
    await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    await settleAfterResponse(page, 'organization-suspend', () => gate.release());
    await expect(dialog).toBeHidden();
    expect(requests).toBe(1);
  });

  test('先に別の画面で操作されていた（409）ときは、状態が変わっていたと知らせて一覧を読み直す', async ({ page }) => {
    const listed = [
      organization({}),
      organization({ slug: 'hibari', name: 'ひばり工房', suspended_at: '2026-10-10T00:00:00.000Z' }),
    ];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    await page.route('**/api/organization-suspend', (route) => {
      listed[0] = organization({ suspended_at: '2026-10-25T00:00:00.000Z' });
      return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x' } } });
    });
    await page.route('**/api/organization-resume', (route) => {
      listed[1] = organization({ slug: 'hibari', name: 'ひばり工房' });
      return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x' } } });
    });
    await page.goto('/operator');

    await page.getByRole('button', { name: '「あおば開発」を停止する' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '「あおば開発」を停止する' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '「あおば開発」の状態が変わっていました' })).toBeVisible();
    await expect(page.locator('.table tbody tr', { hasText: 'あおば開発' }).getByRole('button')).toHaveText('再開する');

    await page.getByRole('button', { name: '「ひばり工房」を再開する' }).click();
    await expect(page.getByRole('status').filter({ hasText: '「ひばり工房」の状態が変わっていました' })).toBeVisible();
    await expect(page.locator('.table tbody tr', { hasText: 'ひばり工房' }).getByRole('button')).toHaveText('停止する');
  });

  test('停止の通信や 5xx の失敗は、ダイアログを開いたまま中に理由を出し、見つからない（404）はトーストで知らせて閉じる', async ({
    page,
  }) => {
    await mockList(page, [organization({})]);
    let status = 500;
    await page.route('**/api/organization-suspend', (route) =>
      route.fulfill({
        status,
        json: { error: { code: status === 404 ? 'not_found' : 'internal', message: 'x' } },
      }),
    );
    await page.goto('/operator');
    await page.getByRole('button', { name: '「あおば開発」を停止する' }).click();
    const dialog = page.getByRole('dialog', { name: '冒険者ギルドを停止する' });
    await dialog.getByRole('button', { name: '「あおば開発」を停止する' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('冒険者ギルドを停止できませんでした。もう一度試してください。');
    await expect(dialog).toBeVisible();

    status = 404;
    await dialog.getByRole('button', { name: '「あおば開発」を停止する' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: '「あおば開発」を操作できませんでした' })).toBeVisible();
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
  for (const name of [
    'list-organizations',
    'resolve-github-user',
    'create-organization',
    'organization-suspend',
    'organization-resume',
  ]) {
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
