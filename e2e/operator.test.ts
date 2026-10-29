// 一時: #451 の確認方法の 3（確かめた後に消す）
// 運用の画面（組織の一覧と、組織の作成、停止と再開、管理者の指名し直しのダイアログ）。seed のセッション（seed/sessions.ts）の Cookie で開く。
// e2e の Worker には運用者の一覧（シークレット OPERATOR_LOGIN_IDS）が無く、本物の GitHub へも行かないので、運用者の操作
// （組織の一覧、ユーザー名の解決、組織の作成）の応答は差し替える。サーバーの処理は test/operator-organizations.test.ts、
// 運用者でない人の扱い（403、/ への戻し）は本物のサーバーで確かめる
import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { expectFocusReturned, signIn, watchViolations } from './helpers.ts';

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
  purge_due: boolean;
  created_at: string;
  admin_status: 'none' | 'pending' | 'expired' | 'active';
  seats: { used: number; limit: number };
  workspace_count: number;
  task_count: number;
  attachment_quota_bytes: number;
  last_used_at: string | null;
};

const organization = (overrides: Partial<ListedOrganization>): ListedOrganization => ({
  slug: 'aoba',
  name: 'あおば開発',
  suspended_at: null,
  purge_on: null,
  purge_due: false,
  created_at: '2026-10-01T09:30:00.000Z',
  admin_status: 'active',
  seats: { used: 5, limit: 15 },
  workspace_count: 3,
  task_count: 1284,
  attachment_quota_bytes: 32212254720,
  last_used_at: '2026-10-20T00:12:00.000Z',
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
      organization({ slug: 'kamome', name: 'かもめ社', suspended_at: '2026-10-10T20:00:00.000Z' }),
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
    // 停止した日は UTC の日付（東京のブラウザでは 10/11 5:00 になる時刻でも 10/10）。一時的な停止には、消す予定日の印を付けない
    await expect(rows.filter({ hasText: 'かもめ社' }).locator('.chip.is-warn')).toHaveText('停止 2026-10-10');
    await expect(rows.filter({ hasText: 'かもめ社' }).locator('.chip.is-danger')).toHaveCount(0);
    // 解約には、消す予定日の印も付く
    await expect(rows.filter({ hasText: 'とき運送' }).locator('.chip.is-warn')).toHaveText('停止 2026-10-11');
    await expect(rows.filter({ hasText: 'とき運送' }).locator('.chip.is-danger')).toHaveText('2026-11-10 に消す');
    // 操作のボタンは、どの行にも「管理者を指名」。続けて、停止していない組織は「停止する」（is-danger）、停止中の組織は「再開する」
    const activeButtons = rows.filter({ hasText: 'あおば開発' }).locator('td.is-actions').getByRole('button');
    await expect(activeButtons).toHaveText(['ギルドマスターを指名', '停止する']);
    await expect(activeButtons.first()).not.toHaveClass(/is-danger/);
    await expect(activeButtons.last()).toHaveClass(/is-danger/);
    // 停止中の行は「管理者を指名」「停止の理由を変える」「再開する」。どれも危険の色にしない
    const suspendedButtons = rows.filter({ hasText: 'かもめ社' }).locator('td.is-actions').getByRole('button');
    await expect(suspendedButtons).toHaveText(['ギルドマスターを指名', '停止の理由を変える', '再開する']);
    for (const button of await suspendedButtons.all()) await expect(button).not.toHaveClass(/is-danger/);
    // 読み上げの名前に、どの組織かを添える
    await expect(
      rows.filter({ hasText: 'ひばり工房' }).locator('td.is-actions').getByRole('button').first(),
    ).toHaveAccessibleName('「ひばり工房」のギルドマスターを指名');
    // 2026-10-01T09:30Z は、東京のブラウザでは 18:30
    // 作った日時は列にせず、名前の列の slug の行に並べる
    await expect(rows.filter({ hasText: 'あおば開発' }).locator('td.is-name .props-note')).toHaveText(
      'aoba · 作成 2026/10/01 18:30',
    );
    // slug と日時は等幅の書体で出す
    await expect(rows.filter({ hasText: 'あおば開発' }).locator('td.is-name .props-note .mono')).toHaveText([
      'aoba',
      '2026/10/01 18:30',
    ]);
    expect(await collect()).toEqual([]);
  });

  test('組織ごとの集計（人数と上限、ワークスペースとタスクの数、添付ファイルの上限、最後に使われた日時）を出し、上限に達した組織に印を付ける', async ({
    page,
  }) => {
    await mockList(page, [
      organization({}),
      organization({
        slug: 'hibari',
        name: 'ひばり工房',
        seats: { used: 15, limit: 15 },
        workspace_count: 1,
        task_count: 212,
        attachment_quota_bytes: 107374182400,
      }),
      organization({
        slug: 'tsubame',
        name: 'つばめ商会',
        seats: { used: 0, limit: 15 },
        workspace_count: 0,
        task_count: 0,
        attachment_quota_bytes: 512 * 1024 ** 2,
        last_used_at: null,
      }),
    ]);
    const collect = await watchViolations(page);
    await page.goto('/operator');
    const rows = page.locator('.table tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('.table thead th')).toHaveText([
      '冒険者ギルド・slug',
      '人数 / 上限',
      'パーティの数',
      'クエストの数',
      '添付ファイルの上限',
      '最後に使われた日時',
      '操作',
    ]);
    const aoba = rows.filter({ hasText: 'あおば開発' });
    await expect(aoba.locator('td[data-label="人数 / 上限"]')).toHaveText('5 / 15');
    await expect(aoba.locator('td[data-label="パーティの数"]')).toHaveText('3');
    await expect(aoba.locator('td[data-label="クエストの数"]')).toHaveText('1,284');
    // 上限の下に、人数と容量の上限を変える文字のボタンを置く。読み上げの名前に、どの組織かを添える
    const aobaQuota = aoba.locator('td[data-label="添付ファイルの上限"]');
    await expect(aobaQuota).toHaveText(/^\s*30\sGB\s*人数と容量の上限を変える\s*$/);
    await expect(aobaQuota.locator('button.link-btn')).toHaveAccessibleName('「あおば開発」の人数と容量の上限を変える');
    // 2026-10-20T00:12Z は、東京のブラウザでは 09:12
    await expect(aoba.locator('td[data-label="最後に使われた日時"]')).toHaveText('2026/10/20 09:12');
    await expect(aoba.locator('.chip')).toHaveCount(0);
    // 人数が上限以上なら「上限に達した」の印
    const hibari = rows.filter({ hasText: 'ひばり工房' });
    await expect(hibari.locator('td[data-label="人数 / 上限"]')).toContainText('15 / 15');
    await expect(hibari.locator('td[data-label="人数 / 上限"] .chip.is-warn')).toHaveText('上限に達した');
    await expect(hibari.locator('td[data-label="添付ファイルの上限"]')).toContainText('100 GB');
    // だれも使っていない組織は、日時の代わりに文で示す
    const tsubame = rows.filter({ hasText: 'つばめ商会' });
    await expect(tsubame.locator('td[data-label="最後に使われた日時"]')).toHaveText('まだ使われていない');
    await expect(tsubame.locator('td[data-label="人数 / 上限"]')).toHaveText('0 / 15');
    // 1 GB 未満の上限は「0 GB」にせず MB で出す
    await expect(tsubame.locator('td[data-label="添付ファイルの上限"]')).toContainText('512 MB');
    await expect(tsubame.locator('td[data-label="添付ファイルの上限"]')).not.toContainText('0 GB');
    // 数と単位の間は不可分の空白で、積んだ行でも割れない
    expect(await aoba.locator('td[data-label="人数 / 上限"]').textContent()).toContain('5 / 15');
    expect(await aoba.locator('td[data-label="添付ファイルの上限"]').textContent()).toContain('30 GB');
    expect(await collect()).toEqual([]);
  });

  // 名前の列の印が折り返さないと、印の長さが列の幅になり、停止中の行の操作（2つのボタン）と合わせて表が横にはみ出していた
  for (const width of [1280, 1024]) {
    test(`${width}px の画面で、停止中の行と長い管理者の状態の印があっても、表の中で横スクロールしない`, async ({
      page,
    }) => {
      await mockList(page, [
        organization({ admin_status: 'expired', seats: { used: 15, limit: 15 } }),
        organization({ slug: 'hibari', name: 'ひばり工房', admin_status: 'pending' }),
        organization({
          slug: 'ibis-transport-and-logistics',
          name: 'とき運送ロジスティクス東日本',
          suspended_at: '2026-10-11T00:00:00.000Z',
          purge_on: '2026-11-10',
          admin_status: 'expired',
          task_count: 123456,
        }),
      ]);
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/operator');
      await expect(page.locator('.table tbody tr')).toHaveCount(3);
      const wrap = page.locator('.table-wrap');
      const sizes = await wrap.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      if (width === 1280) expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
      // 1024px で収まらないときも、ページは横にはみ出さず、表の中のスクロールで受ける
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  // 狭い幅では、固定した操作の列が名前の列を覆い、どの組織への操作か見えなくなっていた。1行を縦に積み、名前と操作を両方見せる
  for (const width of [320, 390]) {
    test(`${width}px の幅でも、停止中の行の名前と操作が重ならず、横にはみ出さない`, async ({ page }) => {
      await mockList(page, [
        organization({}),
        organization({
          slug: 'kamome',
          name: 'かもめ社',
          suspended_at: '2026-10-10T20:00:00.000Z',
          seats: { used: 15, limit: 15 },
        }),
        organization({
          slug: 'ibis',
          name: 'とき運送',
          suspended_at: '2026-10-11T00:00:00.000Z',
          purge_on: '2026-11-10',
          // 印の中でいちばん長い文（ギルドマスターの招待の URL は期限切れ）
          admin_status: 'expired',
          last_used_at: null,
        }),
      ]);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/operator');
      const wrap = page.locator('.table-wrap');
      await expect(page.locator('.table tbody tr')).toHaveCount(3);
      const wrapBox = (await wrap.boundingBox())!;
      expect(await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // 積んだ行では、見出しの代わりに data-label を値の前に出す
      const seatCell = page.locator('.table tbody tr').filter({ hasText: 'かもめ社' }).locator('td').nth(1);
      expect(await seatCell.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('人数 / 上限');
      await expect(seatCell.locator('.chip')).toHaveText('上限に達した');
      // 印は右端で切れず、行の中で折り返す
      const chips = page.locator('.table tbody .chip');
      await expect(chips.filter({ hasText: '招待の URL は期限切れ' })).toBeVisible();
      for (const chip of await chips.all()) {
        const box = (await chip.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(wrapBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(wrapBox.x + wrapBox.width);
      }

      for (const [name, buttonTexts] of [
        ['あおば開発', ['ギルドマスターを指名', '停止する']],
        ['かもめ社', ['ギルドマスターを指名', '停止の理由を変える', '再開する']],
        ['とき運送', ['ギルドマスターを指名', '停止の理由を変える', '再開する']],
      ] as const) {
        const row = page.locator('.table tbody tr').filter({ hasText: name });
        const nameBox = (await row.locator('td.is-name').boundingBox())!;
        // 名前のセルは表の見える幅に収まり、名前の文字は隠れない
        expect(nameBox.x).toBeGreaterThanOrEqual(wrapBox.x);
        expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(wrapBox.x + wrapBox.width);
        await expect(row.locator('td.is-name')).toContainText(name);
        for (const text of buttonTexts) {
          const button = row.getByRole('button', { name: new RegExp(text) });
          await expect(button).toBeVisible();
          const box = (await button.boundingBox())!;
          // 名前のセルの下に置く（名前の上には重ならない）。押せる範囲は 44px 四方以上で、表の見える幅に収まる
          expect(box.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(wrapBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(wrapBox.x + wrapBox.width);
        }
      }
    });
  }

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
    // 招待の URL を失ったときと期限が切れたときは、指名し直すと新しい URL が出ることを添える
    await expect(
      dialog.getByText('一覧の「ギルドマスターを指名」から指名し直すと、新しい招待の URL が出ます'),
    ).toBeVisible();
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
    await expectFocusReturned(page, button);
    expect(sent).toBeUndefined();

    await button.click();
    await dialog.getByRole('radio', { name: /解約/ }).check();
    await dialog.getByRole('button', { name: '「ひばり工房」を停止する' }).click();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual({ slug: 'hibari', kind: 'cancellation' });

    await expect(page.getByRole('status').filter({ hasText: '「ひばり工房」を停止しました' })).toBeVisible();
    await expect(row.locator('.chip.is-warn')).toHaveText('停止 2026-10-26');
    await expect(row.locator('.chip.is-danger')).toHaveText('2026-11-25 に消す');
    await expect(row.locator('td.is-actions').getByRole('button')).toHaveText([
      'ギルドマスターを指名',
      '停止の理由を変える',
      '再開する',
    ]);
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
    await expect(page.getByRole('status').filter({ hasText: '「ひばり工房」を再開しました' })).toBeVisible();
    await expect(row.locator('.chip')).toHaveCount(0);
    await expect(row.locator('td.is-actions').getByRole('button')).toHaveText(['ギルドマスターを指名', '停止する']);
  });

  test('再開を送っている間は、送っている行のボタンの文字が「再開しています」になり、押しても二重に送らない', async ({
    page,
  }) => {
    const listed = [organization({ slug: 'hibari', name: 'ひばり工房', suspended_at: '2026-10-10T00:00:00.000Z' })];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    let requests = 0;
    const gate = deferred<void>();
    await page.route('**/api/organization-resume', async (route) => {
      requests++;
      await gate.promise;
      listed[0] = organization({ slug: 'hibari', name: 'ひばり工房' });
      await route.fulfill({ json: { slug: 'hibari' } });
    });
    await page.goto('/operator');
    const row = page.locator('.table tbody tr', { hasText: 'ひばり工房' });
    const resume = row.getByRole('button', { name: '「ひばり工房」を再開する' });
    await resume.click();

    await expect(resume).toHaveText('再開しています');
    await expect(resume).toHaveAttribute('aria-disabled', 'true');
    // 見える文字は替わるが、読み上げの名前は据え置く
    await expect(resume).toHaveAccessibleName('「ひばり工房」を再開する');
    await resume.click({ force: true });
    await row.getByRole('button', { name: '「ひばり工房」の停止の理由を変える' }).click({ force: true });
    // 上限を変える文字のボタンも押せない見た目にし、押してもダイアログを開かない
    const quota = row.getByRole('button', { name: '「ひばり工房」の人数と容量の上限を変える' });
    await expect(quota).toHaveAttribute('aria-disabled', 'true');
    expect(await quota.evaluate((el) => getComputedStyle(el).cursor)).toBe('not-allowed');
    await quota.click({ force: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await settleAfterResponse(page, 'organization-resume', () => gate.release());
    await expect(row.locator('td.is-actions').getByRole('button')).toHaveText(['ギルドマスターを指名', '停止する']);
    expect(requests).toBe(1);
  });

  test('「停止の理由を変える」は、今の理由を選んだ状態で開き、今と同じ理由では変えられず、選び直して送ると一覧が読み直される', async ({
    page,
  }) => {
    const listed = [
      organization({ slug: 'hibari', name: 'ひばり工房', suspended_at: '2026-10-10T00:00:00.000Z' }),
      organization({
        slug: 'tsubame',
        name: 'つばめ商会',
        suspended_at: '2026-10-11T00:00:00.000Z',
        purge_on: '2026-11-10',
      }),
    ];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    let sent: unknown;
    await page.route('**/api/organization-suspension-update', async (route) => {
      sent = route.request().postDataJSON();
      listed[0] = organization({
        slug: 'hibari',
        name: 'ひばり工房',
        suspended_at: '2026-10-10T00:00:00.000Z',
        purge_on: '2026-11-25',
      });
      await route.fulfill({ json: { slug: 'hibari', purge_on: '2026-11-25' } });
    });
    await page.goto('/operator');

    // 解約の組織は、解約を選んだ状態で開く。危険の色にはしない
    await page.getByRole('button', { name: '「つばめ商会」の停止の理由を変える' }).click();
    const dialog = page.getByRole('dialog', { name: '停止の理由を変える' });
    await expect(dialog.getByRole('radio', { name: /解約/ })).toBeChecked();
    await expect(page.locator('.dialog-sheet.is-danger')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();

    const button = page.getByRole('button', { name: '「ひばり工房」の停止の理由を変える' });
    await button.click();
    const current = dialog.getByRole('radio', { name: /一時的に止める/ });
    await expect(current).toBeChecked();
    // 最初のフォーカスは、選ばれている今の理由に置く
    await expect(current).toBeFocused();
    // 今と同じ理由では、「変える」を押しても何も送らない。押せない理由を見える文字と読み上げで伝える
    const change = dialog.getByRole('button', { name: '変える' });
    await expect(change).toHaveAttribute('aria-disabled', 'true');
    await expect(change).toHaveAccessibleDescription('今の理由です。別の理由を選ぶと変えられます。');
    await expect(dialog.getByText('今の理由です。別の理由を選ぶと変えられます。')).toBeVisible();
    await change.click({ force: true });
    expect(sent).toBeUndefined();

    await dialog.getByRole('radio', { name: /解約/ }).check();
    await expect(change).toHaveAttribute('aria-disabled', 'false');
    await expect(change).not.toHaveAttribute('aria-describedby');
    await expect(dialog.getByText('今の理由です。別の理由を選ぶと変えられます。')).toBeHidden();
    await change.click();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual({ slug: 'hibari', kind: 'cancellation' });
    await expect(page.getByRole('status').filter({ hasText: '「ひばり工房」の停止の理由を変えました' })).toBeVisible();
    const row = page.locator('.table tbody tr', { hasText: 'ひばり工房' });
    await expect(row.locator('.chip.is-warn')).toHaveText('停止 2026-10-10');
    await expect(row.locator('.chip.is-danger')).toHaveText('2026-11-25 に消す');
  });

  test('消す予定日を過ぎた解約の組織の行は、管理者の指名、停止の理由の切り替え、再開を出さず、できない理由を出す', async ({
    page,
  }) => {
    await mockList(page, [
      organization({
        slug: 'kiri',
        name: 'きり製作所',
        suspended_at: '2026-09-10T00:00:00.000Z',
        purge_on: '2026-10-10',
        purge_due: true,
      }),
      organization({
        slug: 'nagi',
        name: 'なぎ設計',
        suspended_at: '2026-10-11T00:00:00.000Z',
        purge_on: '2026-11-10',
      }),
    ]);
    const collect = await watchViolations(page);
    await page.goto('/operator');
    const due = page.locator('.table tbody tr', { hasText: 'きり製作所' });
    await expect(due.locator('.chip.is-danger')).toHaveText('2026-10-10 に消す');
    const actions = due.locator('td.is-actions');
    // 管理者の指名し直しも出さない（サーバーが purge_due で断る）
    await expect(actions.getByRole('button')).toHaveCount(0);
    await expect(actions.locator('.props-note')).toHaveText(
      '消す予定日を過ぎたので、再開も停止の理由の切り替えもギルドマスターの指名もできません',
    );
    // 予定日を過ぎていない解約の組織は、今どおり両方を出す
    await expect(
      page.locator('.table tbody tr', { hasText: 'なぎ設計' }).locator('td.is-actions').getByRole('button'),
    ).toHaveText(['ギルドマスターを指名', '停止の理由を変える', '再開する']);
    expect(await collect()).toEqual([]);
  });

  test('390px の幅でも、消す予定日を過ぎた行の理由の注記は行の中で折り返し、横にはみ出さない', async ({ page }) => {
    await mockList(page, [
      organization({}),
      organization({
        slug: 'kiri',
        name: 'きり製作所',
        suspended_at: '2026-09-10T00:00:00.000Z',
        purge_on: '2026-10-10',
        purge_due: true,
        admin_status: 'expired',
      }),
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/operator');
    const wrap = page.locator('.table-wrap');
    const note = page.locator('.table tbody tr', { hasText: 'きり製作所' }).locator('td.is-actions .props-note');
    await expect(note).toBeVisible();
    expect(await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const wrapBox = (await wrap.boundingBox())!;
    const noteBox = (await note.boundingBox())!;
    expect(noteBox.x).toBeGreaterThanOrEqual(wrapBox.x);
    expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(wrapBox.x + wrapBox.width);
    // 操作の列の nowrap を継がない
    expect(await note.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('normal');
  });

  // 1024px は表の最小の幅に届かず、元から .table-wrap の横スクロールで受ける（docs/design.md の Gate の wide）。
  // 横スクロールが無いことは、収まる 1280px でだけ確かめる
  for (const { width, fits } of [
    { width: 1024, fits: false },
    { width: 1280, fits: true },
  ]) {
    test(`${width}px の幅では、消す予定日を過ぎた行の理由の注記は縦長に潰れない`, async ({ page }) => {
      await mockList(page, [
        organization({}),
        organization({
          slug: 'kiri',
          name: 'きり製作所',
          suspended_at: '2026-09-10T00:00:00.000Z',
          purge_on: '2026-10-10',
          purge_due: true,
          admin_status: 'expired',
        }),
      ]);
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/operator');
      const wrap = page.locator('.table-wrap');
      const note = page.locator('.table tbody tr', { hasText: 'きり製作所' }).locator('td.is-actions .props-note');
      await expect(note).toBeVisible();
      if (fits) expect(await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // 1行に数文字ずつの縦長にならない（3行まで）
      const lines = await note.evaluate(
        (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
      );
      expect(lines).toBeLessThanOrEqual(3.2);
    });
  }

  test('purge_due で断られた後、読み直した行がまだ予定日を過ぎていなければ、画面の見出しへフォーカスを移す', async ({
    page,
  }) => {
    await mockList(page, [
      organization({
        slug: 'kiri',
        name: 'きり製作所',
        suspended_at: '2026-09-10T00:00:00.000Z',
        purge_on: '2026-10-10',
      }),
    ]);
    await page.route('**/api/organization-resume', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'purge_due', message: 'x' } } }),
    );
    await page.goto('/operator');
    await page.getByRole('button', { name: '「きり製作所」を再開する' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '「きり製作所」は消す予定日を過ぎたので再開できません' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: '運用' })).toBeFocused();
  });

  test('開いた後に予定日を過ぎ、再開や理由の切り替えが purge_due で断られたら、理由を知らせて読み直し、理由へフォーカスを移す', async ({
    page,
  }) => {
    const listed = [
      organization({
        slug: 'kiri',
        name: 'きり製作所',
        suspended_at: '2026-09-10T00:00:00.000Z',
        purge_on: '2026-10-10',
      }),
      organization({
        slug: 'nagi',
        name: 'なぎ設計',
        suspended_at: '2026-10-11T00:00:00.000Z',
        purge_on: '2026-10-10',
      }),
    ];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    const purgeDue = { status: 409, json: { error: { code: 'purge_due', message: 'x' } } };
    await page.route('**/api/organization-resume', (route) => {
      listed[0] = { ...listed[0]!, purge_due: true };
      return route.fulfill(purgeDue);
    });
    let sent: unknown;
    await page.route('**/api/organization-suspension-update', (route) => {
      sent = route.request().postDataJSON();
      listed[1] = { ...listed[1]!, purge_due: true };
      return route.fulfill(purgeDue);
    });
    await page.goto('/operator');

    await page.getByRole('button', { name: '「きり製作所」を再開する' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '「きり製作所」は消す予定日を過ぎたので再開できません' }),
    ).toBeVisible();
    const kiri = page.locator('.table tbody tr', { hasText: 'きり製作所' }).locator('td.is-actions');
    await expect(kiri.getByRole('button')).toHaveCount(0);
    await expect(kiri.locator('.props-note')).toBeFocused();

    await page.getByRole('button', { name: '「なぎ設計」の停止の理由を変える' }).click();
    const dialog = page.getByRole('dialog', { name: '停止の理由を変える' });
    await dialog.getByRole('radio', { name: /一時的に止める/ }).check();
    await dialog.getByRole('button', { name: '変える' }).click();
    await expect(dialog).toBeHidden();
    expect(sent).toEqual({ slug: 'nagi', kind: 'temporary' });
    await expect(
      page.getByRole('status').filter({ hasText: '「なぎ設計」は消す予定日を過ぎたので、停止の理由を変えられません' }),
    ).toBeVisible();
    const nagi = page.locator('.table tbody tr', { hasText: 'なぎ設計' }).locator('td.is-actions');
    await expect(nagi.getByRole('button')).toHaveCount(0);
    await expect(nagi.locator('.props-note')).toHaveText(
      '消す予定日を過ぎたので、再開も停止の理由の切り替えもギルドマスターの指名もできません',
    );
    await expect(nagi.locator('.props-note')).toBeFocused();
  });

  test('開いた後に予定日を過ぎ、管理者の指名し直しが purge_due で断られたら、閉じて理由を知らせ、読み直して理由へフォーカスを移す', async ({
    page,
  }) => {
    const listed = [
      organization({
        slug: 'kiri',
        name: 'きり製作所',
        suspended_at: '2026-09-10T00:00:00.000Z',
        purge_on: '2026-10-10',
      }),
    ];
    await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
    let sent: unknown;
    await page.route('**/api/organization-admin-reassign', (route) => {
      sent = route.request().postDataJSON();
      listed[0] = { ...listed[0]!, purge_due: true };
      return route.fulfill({ status: 409, json: { error: { code: 'purge_due', message: 'x' } } });
    });
    await page.goto('/operator');
    await page.getByRole('button', { name: '「きり製作所」のギルドマスターを指名' }).click();
    const dialog = page.getByRole('dialog', { name: 'ギルドマスターを指名し直す' });
    await dialog.getByRole('radio', { name: 'Google' }).check();
    await dialog.getByLabel('Google のメールアドレス').fill('kai.tsukishiro@example.com');
    await dialog.getByRole('button', { name: '指名する', exact: true }).click();

    await expect(dialog).toBeHidden();
    expect(sent).toEqual({ slug: 'kiri', admin: { provider: 'google', email: 'kai.tsukishiro@example.com' } });
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: '「きり製作所」は消す予定日を過ぎたので、ギルドマスターを指名できません' }),
    ).toBeVisible();
    const kiri = page.locator('.table tbody tr', { hasText: 'きり製作所' }).locator('td.is-actions');
    await expect(kiri.getByRole('button')).toHaveCount(0);
    await expect(kiri.locator('.props-note')).toBeFocused();
  });

  test('長い組織の名前は、停止のダイアログの本文で折り返し、横にはみ出さない', async ({ page }) => {
    const longName = 'とても長い名前の組織'.repeat(8) + 'x'.repeat(60);
    await mockList(page, [organization({ name: longName })]);
    await page.goto('/operator');
    await page.getByRole('button', { name: `「${longName}」を停止する` }).click();
    const text = page.getByRole('dialog').locator('p.wrap-anywhere');
    await expect(text).toContainText(longName);
    expect(await text.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
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
    await expect(page.getByRole('button', { name: '「あおば開発」を再開する' })).toHaveText('再開する');

    await page.getByRole('button', { name: '「ひばり工房」を再開する' }).click();
    await expect(page.getByRole('status').filter({ hasText: '「ひばり工房」の状態が変わっていました' })).toBeVisible();
    await expect(
      page.locator('.table tbody tr', { hasText: 'ひばり工房' }).locator('td.is-actions').getByRole('button'),
    ).toHaveText(['ギルドマスターを指名', '停止する']);
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

  // 人数と添付ファイルの上限の変更（organization-quota-update）。サーバーの処理は test/operator-quota.test.ts
  test.describe('上限の変更', () => {
    const GIB = 1024 ** 3;

    test('今の上限に合う段階を選んで開き、同じ値では変えられず、標準を選んで送ると一覧が読み直される', async ({
      page,
    }) => {
      const listed = [organization({}), organization({ slug: 'hibari', name: 'ひばり工房' })];
      await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
      let sent: unknown;
      await page.route('**/api/organization-quota-update', async (route) => {
        sent = route.request().postDataJSON();
        listed[0] = organization({ seats: { used: 5, limit: 50 }, attachment_quota_bytes: 100 * GIB });
        await route.fulfill({ json: { slug: 'aoba', member_limit: 50, attachment_quota_bytes: 100 * GIB } });
      });
      const collect = await watchViolations(page);
      await page.goto('/operator');
      const button = page.getByRole('button', { name: '「あおば開発」の人数と容量の上限を変える' });
      await expect(button).toHaveText('人数と容量の上限を変える');
      await button.click();

      const dialog = page.getByRole('dialog', { name: '人数と添付ファイルの上限を変える' });
      // 取り消せる変更なので危険の色にしない（閉じている停止のダイアログの枠は数えない）
      await expect(dialog).toBeVisible();
      await expect(page.locator('.dialog-sheet.is-danger:visible')).toHaveCount(0);
      await expect(dialog).toContainText(
        '「あおば開発」の上限を変えます。今は人数 5 人（上限 15 人）、添付ファイルの上限 30',
      );
      await expect(dialog).not.toContainText('{');
      // 数と「人」の間は不可分の空白で、折り返しで割れない
      expect(await dialog.locator('p.wrap-anywhere').textContent()).toContain('5 人（上限 15 人）');
      expect(await dialog.locator('.choice span').first().textContent()).toContain('15 人・30 GB');
      // 添付ファイルの今の合計と、合計に関わる注意は #68 まで出さない
      await expect(dialog).not.toContainText('合計');
      await expect(dialog).not.toContainText('80%');
      await expect(dialog.getByRole('radio')).toHaveCount(3);
      const small = dialog.getByRole('radio', { name: /小さい冒険者ギルド/ });
      await expect(small).toBeChecked();
      await expect(small).toBeFocused();
      await expect(dialog.getByText('15 人・30')).toBeVisible();
      await expect(dialog.getByText('50 人・100')).toBeVisible();
      // ほかの値の欄は、ほかの値を選ぶまで出さない
      await expect(dialog.getByRole('spinbutton')).toHaveCount(0);

      // 今と同じ値では、「変える」を押しても何も送らない。押せない理由を見える文字と読み上げで伝える
      const change = dialog.getByRole('button', { name: '変える' });
      await expect(change).toHaveAttribute('aria-disabled', 'true');
      await expect(change).toHaveAccessibleDescription('今の上限です。別の値を選ぶと変えられます。');
      await change.click({ force: true });
      expect(sent).toBeUndefined();

      // やめれば何も送らず、開いたボタンにフォーカスを戻す
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expectFocusReturned(page, button);

      await button.click();
      await dialog.getByRole('radio', { name: /標準/ }).check();
      await expect(change).toHaveAttribute('aria-disabled', 'false');
      await expect(change).not.toHaveAttribute('aria-describedby');
      await change.click();
      await expect(dialog).toBeHidden();
      // 開いたときに見ていた上限を expected に添え、ダイアログを開いた後に別の運用者が変えていればサーバーが 409 で断る
      expect(sent).toEqual({
        slug: 'aoba',
        member_limit: 50,
        attachment_quota_bytes: 100 * GIB,
        expected: { member_limit: 15, attachment_quota_bytes: 30 * GIB },
      });

      await expect(page.getByRole('status').filter({ hasText: '「あおば開発」の上限を変えました' })).toBeVisible();
      const row = page.locator('.table tbody tr', { hasText: 'あおば開発' });
      await expect(row.locator('td[data-label="人数 / 上限"]')).toHaveText('5 / 50');
      await expect(row.locator('td[data-label="添付ファイルの上限"]')).toContainText('100 GB');
      // 標準の組織は、開き直すと標準を選んだ状態で開く
      await button.click();
      await expect(dialog.getByRole('radio', { name: /標準/ })).toBeChecked();
      expect(await collect()).toEqual([]);
    });

    test('段階に合わない上限は「ほかの値」を今の値で埋めて開き、範囲の外の値は送る前に欄の下で断る', async ({
      page,
    }) => {
      const listed = [
        organization({ seats: { used: 60, limit: 120 }, attachment_quota_bytes: 250 * GIB }),
        organization({ slug: 'hibari', name: 'ひばり工房', attachment_quota_bytes: 512 * 1024 ** 2 }),
      ];
      await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
      const sent: unknown[] = [];
      await page.route('**/api/organization-quota-update', async (route) => {
        sent.push(route.request().postDataJSON());
        listed[0] = organization({ seats: { used: 60, limit: 200 }, attachment_quota_bytes: 300 * GIB });
        await route.fulfill({ json: { slug: 'aoba', member_limit: 200, attachment_quota_bytes: 300 * GIB } });
      });
      const collect = await watchViolations(page);
      await page.goto('/operator');

      // 1 GB 未満の上限は、GB の整数の 1 で埋める
      await page.getByRole('button', { name: '「ひばり工房」の人数と容量の上限を変える' }).click();
      const dialog = page.getByRole('dialog', { name: '人数と添付ファイルの上限を変える' });
      await expect(dialog).toContainText('添付ファイルの上限 512 MB です');
      await expect(dialog.getByRole('spinbutton', { name: '添付ファイルの上限（GB）' })).toHaveValue('1');
      await dialog.getByRole('button', { name: 'やめる' }).click();

      await page.getByRole('button', { name: '「あおば開発」の人数と容量の上限を変える' }).click();
      await expect(dialog.getByRole('radio', { name: /ほかの値/ })).toBeChecked();
      const members = dialog.getByRole('spinbutton', { name: '人数の上限（人）' });
      const size = dialog.getByRole('spinbutton', { name: '添付ファイルの上限（GB）' });
      await expect(members).toHaveValue('120');
      await expect(size).toHaveValue('250');
      // ほかの値のときは、最初のフォーカスを選ばれた選択肢に置く
      await expect(dialog.getByRole('radio', { name: /ほかの値/ })).toBeFocused();
      const change = dialog.getByRole('button', { name: '変える' });
      await expect(change).toHaveAttribute('aria-disabled', 'true');

      // 0 以下と空は断り、最初の誤りの欄へフォーカスを移す
      await members.fill('0');
      await size.fill('');
      await change.click();
      await expect(dialog.locator('.field-error')).toHaveText([
        '人数の上限は 1〜10,000 の整数で入れてください。',
        '添付ファイルの上限は 1〜102,400 の整数（GB）で入れてください。',
      ]);
      await expect(members).toBeFocused();
      await expect(members).toHaveAttribute('aria-invalid', 'true');
      await expect(members).toHaveAccessibleDescription('人数の上限は 1〜10,000 の整数で入れてください。');
      // 選択肢を選び直すと、欄の誤りは消える（ほかの値へ戻しても残らない）
      await dialog.getByRole('radio', { name: /標準/ }).check();
      await dialog.getByRole('radio', { name: /ほかの値/ }).check();
      await expect(dialog.locator('.field-error')).toHaveCount(0);
      await members.fill('0');
      await size.fill('');
      await change.click();
      await expect(dialog.locator('.field-error')).toHaveCount(2);
      // 小数と負の値も断る
      await members.fill('-3');
      await size.fill('1.5');
      await change.click();
      await expect(dialog.locator('.field-error')).toHaveCount(2);
      expect(sent).toEqual([]);

      // 直すと誤りが消え、GB をバイトにして送る
      await members.fill('200');
      await expect(members).toHaveAttribute('aria-invalid', 'false');
      await size.fill('300');
      await expect(dialog.locator('.field-error')).toHaveCount(0);
      await size.press('Enter');
      await expect(dialog).toBeHidden();
      expect(sent).toEqual([
        {
          slug: 'aoba',
          member_limit: 200,
          attachment_quota_bytes: 300 * GIB,
          expected: { member_limit: 120, attachment_quota_bytes: 250 * GIB },
        },
      ]);
      const row = page.locator('.table tbody tr', { hasText: 'あおば開発' });
      await expect(row.locator('td[data-label="人数 / 上限"]')).toHaveText('60 / 200');
      expect(await collect()).toEqual([]);
    });

    test('容量が GB の整数でない組織は、容量の欄を触らなければ今のバイト数のまま送る', async ({ page }) => {
      const MIB_512 = 512 * 1024 ** 2;
      const listed = [organization({ slug: 'hibari', name: 'ひばり工房', attachment_quota_bytes: MIB_512 })];
      await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
      const sent: { member_limit: number; attachment_quota_bytes: number }[] = [];
      await page.route('**/api/organization-quota-update', async (route) => {
        const body = route.request().postDataJSON() as { member_limit: number; attachment_quota_bytes: number };
        sent.push(body);
        listed[0] = organization({
          slug: 'hibari',
          name: 'ひばり工房',
          seats: { used: 5, limit: body.member_limit },
          attachment_quota_bytes: body.attachment_quota_bytes,
        });
        await route.fulfill({ json: { slug: 'hibari', ...body } });
      });
      await page.goto('/operator');
      const open = page.getByRole('button', { name: '「ひばり工房」の人数と容量の上限を変える' });
      const dialog = page.getByRole('dialog', { name: '人数と添付ファイルの上限を変える' });
      await open.click();
      await expect(dialog.getByRole('radio', { name: /ほかの値/ })).toBeChecked();
      // 開いたままなら今の上限と同じなので、「変える」は押せない（欄の 1 GB は表示のための丸め）
      const change = dialog.getByRole('button', { name: '変える' });
      await expect(change).toHaveAttribute('aria-disabled', 'true');

      // 人数だけを変えると、容量は 512 MB のまま送る
      await dialog.getByRole('spinbutton', { name: '人数の上限（人）' }).fill('20');
      await expect(change).toHaveAttribute('aria-disabled', 'false');
      await change.click();
      await expect(dialog).toBeHidden();
      expect(sent).toEqual([
        {
          slug: 'hibari',
          member_limit: 20,
          attachment_quota_bytes: MIB_512,
          expected: { member_limit: 15, attachment_quota_bytes: MIB_512 },
        },
      ]);
      const row = page.locator('.table tbody tr', { hasText: 'ひばり工房' });
      await expect(row.locator('td[data-label="添付ファイルの上限"]')).toContainText('512 MB');

      // 容量の欄を触れば、入れた GB を送る
      await open.click();
      await dialog.getByRole('spinbutton', { name: '添付ファイルの上限（GB）' }).fill('2');
      await change.click();
      await expect(dialog).toBeHidden();
      expect(sent[1]).toMatchObject({ member_limit: 20, attachment_quota_bytes: 2 * GIB });
    });

    test('先に変えられていた（409）、見つからない（404）はトーストで知らせて閉じ、5xx と通信の切れはダイアログの中に理由を出して閉じると読み直す', async ({
      page,
    }) => {
      const listed = [organization({})];
      await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
      let status = 409;
      const failedText =
        '上限を変えられませんでした。変わっていることもあるので、閉じた後の一覧で確かめてからもう一度試してください。';
      await page.route('**/api/organization-quota-update', (route) => {
        if (status === 409) listed[0] = organization({ seats: { used: 5, limit: 30 } });
        // 書かれたか分からない失敗。サーバーでは書けていた
        if (status === 500)
          listed[0] = organization({ seats: { used: 5, limit: 50 }, attachment_quota_bytes: 100 * GIB });
        if (status === 0) return route.abort('connectionreset');
        const code = status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'internal';
        return route.fulfill({ status, json: { error: { code, message: 'x' } } });
      });
      await page.goto('/operator');
      const open = page.getByRole('button', { name: '「あおば開発」の人数と容量の上限を変える' });
      const dialog = page.getByRole('dialog', { name: '人数と添付ファイルの上限を変える' });

      await open.click();
      await dialog.getByRole('radio', { name: /標準/ }).check();
      await dialog.getByRole('button', { name: '変える' }).click();
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole('status').filter({ hasText: '「あおば開発」の状態が変わっていました' }),
      ).toBeVisible();
      await expect(page.locator('td[data-label="人数 / 上限"]')).toHaveText('5 / 30');

      status = 500;
      await open.click();
      // 読み直した上限（30 人）はどの段階にも合わないので、ほかの値で開く
      await expect(dialog.getByRole('radio', { name: /ほかの値/ })).toBeChecked();
      await dialog.getByRole('radio', { name: /標準/ }).check();
      await dialog.getByRole('button', { name: '変える' }).click();
      await expect(dialog.getByRole('alert')).toHaveText(failedText);
      await expect(dialog).toBeVisible();
      // 選択肢を選び直すと、失敗の文は消える
      await dialog.getByRole('radio', { name: /ほかの値/ }).check();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      // 書かれたか分からない失敗の後は、閉じると一覧を読み直す
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('td[data-label="人数 / 上限"]')).toHaveText('5 / 50');

      // 通信の切れも同じ文
      status = 0;
      await open.click();
      await dialog.getByRole('radio', { name: /小さい冒険者ギルド/ }).check();
      await dialog.getByRole('button', { name: '変える' }).click();
      await expect(dialog.getByRole('alert')).toHaveText(failedText);

      status = 404;
      await dialog.getByRole('button', { name: '変える' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('status').filter({ hasText: '「あおば開発」を操作できませんでした' })).toBeVisible();
    });

    test('送っている間は「変える」を押しても無視し、ダイアログも閉じられず、1回しか送らない', async ({ page }) => {
      const listed = [organization({})];
      await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
      let requests = 0;
      const gate = deferred<void>();
      await page.route('**/api/organization-quota-update', async (route) => {
        requests++;
        await gate.promise;
        listed[0] = organization({ seats: { used: 5, limit: 50 }, attachment_quota_bytes: 100 * GIB });
        await route.fulfill({ json: { slug: 'aoba', member_limit: 50, attachment_quota_bytes: 100 * GIB } });
      });
      await page.goto('/operator');
      await page.getByRole('button', { name: '「あおば開発」の人数と容量の上限を変える' }).click();
      const dialog = page.getByRole('dialog', { name: '人数と添付ファイルの上限を変える' });
      await dialog.getByRole('radio', { name: /標準/ }).check();
      await dialog.getByRole('button', { name: '変える' }).click();

      const submitting = dialog.getByRole('button', { name: '変えています' });
      await expect(submitting).toHaveAttribute('aria-disabled', 'true');
      await expect(dialog.getByRole('status')).toHaveText('変えています');
      await submitting.click({ force: true });
      await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();

      await settleAfterResponse(page, 'organization-quota-update', () => gate.release());
      await expect(dialog).toBeHidden();
      expect(requests).toBe(1);
    });
  });

  // 管理者の指名し直し（organization-admin-reassign）。サーバーの処理は test/operator-admin-reassign.test.ts
  test.describe('管理者の指名し直し', () => {
    async function openReassign(page: Page, name: string) {
      await page.getByRole('button', { name: `「${name}」のギルドマスターを指名` }).click();
      await expect(page.getByRole('dialog', { name: 'ギルドマスターを指名し直す' })).toBeVisible();
      // 指名した後は、同じダイアログの見出しが「指名しました」に替わる（開いているダイアログは1つ）
      return page.getByRole('dialog');
    }

    test('GitHub のユーザー名を確かめてから指名すると、組織の URL と伝えることが出て、閉じると一覧の管理者の状態が変わる', async ({
      page,
    }) => {
      const listed = [organization({}), organization({ slug: 'hibari', name: 'ひばり工房', admin_status: 'none' })];
      await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
      await mockGithubUser(page, TOKYO_USER);
      let sent: unknown;
      await page.route('**/api/organization-admin-reassign', async (route) => {
        sent = route.request().postDataJSON();
        listed[1] = organization({ slug: 'hibari', name: 'ひばり工房', admin_status: 'pending' });
        await route.fulfill({ json: { slug: 'hibari', admin_login_name: 'alice-dev', invite: null } });
      });
      const collect = await watchViolations(page);
      await page.goto('/operator');
      const row = page.locator('.table tbody tr', { hasText: 'ひばり工房' });
      const trigger = row.getByRole('button', { name: '「ひばり工房」のギルドマスターを指名' });
      const dialog = await openReassign(page, 'ひばり工房');
      // 文は開いたときの管理者の状態で変える
      await expect(dialog).toContainText('「ひばり工房」には今ギルドマスターがいません');
      await expect(dialog).toContainText('まだログインしていない前の指名は取り消されます');
      await expect(dialog).toContainText('運用者の操作として残ります');
      await expect(dialog).not.toContainText('{');
      // 確かめるまで指名できない
      const submit = dialog.getByRole('button', { name: '指名する', exact: true });
      await expect(submit).toBeDisabled();
      await dialog.getByLabel('GitHub のユーザー名').fill('alice');
      await dialog.getByRole('button', { name: '確かめる' }).click();
      await expect(dialog.getByText('この人をギルドマスターにします')).toBeVisible();
      await expect(dialog.locator('.choice b.mono')).toHaveText('alice-dev');
      await submit.click();

      await expect(dialog.getByRole('heading', { name: 'ギルドマスターを指名しました' })).toBeVisible();
      await expect(dialog.getByRole('status')).toHaveText('指名しました');
      await expect(dialog.locator('p[tabindex="-1"]')).toBeFocused();
      await expect(dialog.getByLabel('冒険者ギルドの URL')).toHaveValue(/\/hibari\/$/);
      await expect(dialog.getByText('GitHub の alice-dev でログインするよう伝えてください。')).toBeVisible();
      expect(sent).toEqual({
        slug: 'hibari',
        admin: { provider: 'github', username: 'alice', login_subject: '5550010' },
      });
      expect(await collect()).toEqual([]);

      await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
      await expect(dialog).toBeHidden();
      await expect(row.locator('.chip.is-warn')).toHaveText('ギルドマスターは指名済み、ログイン待ち');
      await expect(row.locator('.chip.is-danger')).toHaveCount(0);
      await expectFocusReturned(page, trigger);
    });

    test('Google のメールアドレスで指名すると、招待の URL と期限が出てコピーでき、閉じると二度と出ず、一覧の状態が変わる', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const listed = [
        organization({
          slug: 'kamome',
          name: 'かもめ社',
          admin_status: 'expired',
          suspended_at: '2026-10-10T00:00:00.000Z',
        }),
      ];
      await page.route('**/api/list-organizations', (route) => route.fulfill({ json: { organizations: listed } }));
      const inviteUrl = `http://localhost:8787/invite#${'Zx8tY2vLr9aKpE4wQc8hN3bYd6fGs1uJ0oTiRl5eWmB'}`;
      let sent: unknown;
      await page.route('**/api/organization-admin-reassign', async (route) => {
        sent = route.request().postDataJSON();
        listed[0] = { ...listed[0]!, admin_status: 'pending' };
        await route.fulfill({
          json: {
            slug: 'kamome',
            admin_login_name: 'nagi.kurose@example.com',
            invite: { url: inviteUrl, expires_at: '2026-11-09T00:00:00.000Z' },
          },
        });
      });
      const collect = await watchViolations(page);
      await page.goto('/operator');
      const row = page.locator('.table tbody tr', { hasText: 'かもめ社' });
      // 停止中の組織にも指名できる
      const dialog = await openReassign(page, 'かもめ社');
      await expect(dialog).toContainText('「かもめ社」のギルドマスターの招待の URL は、期限が切れています');
      await dialog.getByRole('radio', { name: 'Google' }).check();
      await expect(dialog.getByRole('button', { name: '確かめる' })).toHaveCount(0);
      const submit = dialog.getByRole('button', { name: '指名する', exact: true });
      await expect(submit).toBeDisabled();
      await dialog.getByLabel('Google のメールアドレス').fill(' Nagi.Kurose@Example.com ');
      await submit.click();

      await expect(dialog.getByRole('heading', { name: 'ギルドマスターを指名しました' })).toBeVisible();
      await expect(dialog.getByLabel('招待の URL')).toHaveValue(inviteUrl);
      await expect(dialog.locator('b.mono.wrap-anywhere')).toHaveText('nagi.kurose@example.com');
      await expect(dialog.getByText('期限は14日（2026/11/09 09:00 まで）')).toBeVisible();
      await expect(dialog.getByText('この画面を閉じると二度と出せません')).toBeVisible();
      await dialog.getByRole('button', { name: 'コピー' }).click();
      await expect(page.getByRole('status').filter({ hasText: '招待の URL をコピーしました' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inviteUrl);
      expect(sent).toEqual({ slug: 'kamome', admin: { provider: 'google', email: 'Nagi.Kurose@Example.com' } });
      expect(await collect()).toEqual([]);

      await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
      await expect(dialog).toBeHidden();
      await expect(row.locator('.chip', { hasText: 'ギルドマスター' })).toHaveText(
        'ギルドマスターは指名済み、ログイン待ち',
      );
      // 開き直しても、招待の URL は二度と出ない。文は今の状態（ログイン待ち）に変わる
      const again = await openReassign(page, 'かもめ社');
      await expect(again).toContainText('「かもめ社」のギルドマスターは指名済みで、まだログインしていません');
      await expect(again.getByLabel('招待の URL')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('Zx8tY2vLr9aKpE4wQc8hN3bYd6fGs1uJ0oTiRl5eWmB');
    });

    test('やめると何も送らず、一覧も読み直さない。ログインした管理者がいる組織では、今の管理者が外れないことを添える', async ({
      page,
    }) => {
      let lists = 0;
      await page.route('**/api/list-organizations', (route) => {
        lists++;
        return route.fulfill({ json: { organizations: [organization({})] } });
      });
      let sent = false;
      await page.route('**/api/organization-admin-reassign', (route) => {
        sent = true;
        return route.abort();
      });
      await page.goto('/operator');
      await expect(page.locator('.table tbody tr')).toHaveCount(1);
      const before = lists;
      const dialog = await openReassign(page, 'あおば開発');
      await expect(dialog).toContainText('「あおば開発」には、ログインしたギルドマスターがいます');
      await expect(dialog).toContainText('今のギルドマスターは外れません');
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      expect(sent).toBe(false);
      expect(lists).toBe(before);
    });

    test('失敗は理由ごとの文言で出す（409、404、503、入力の誤り、届かない）。書かれたか分からない失敗の後は一覧を読み直す', async ({
      page,
    }) => {
      let lists = 0;
      await page.route('**/api/list-organizations', (route) => {
        lists++;
        return route.fulfill({ json: { organizations: [organization({ admin_status: 'none' })] } });
      });
      await mockGithubUser(page, TOKYO_USER);
      type Reply = Parameters<Route['fulfill']>[0] | 'abort';
      let reply: Reply = {};
      await page.route('**/api/organization-admin-reassign', (route) =>
        reply === 'abort' ? route.abort() : route.fulfill(reply),
      );
      await page.goto('/operator');
      const dialog = await openReassign(page, 'あおば開発');
      await dialog.getByLabel('GitHub のユーザー名').fill('alice');
      await dialog.getByRole('button', { name: '確かめる' }).click();
      const submit = dialog.getByRole('button', { name: '指名する', exact: true });
      await expect(submit).toBeEnabled();

      const cases: [Reply, string, boolean][] = [
        [
          { status: 409, json: { error: { code: 'conflict', message: 'x' } } },
          '指名している間に、この冒険者ギルドの人の状態が変わりました',
          true,
        ],
        [
          { status: 404, json: { error: { code: 'not_found', message: 'x' } } },
          'この冒険者ギルドが見つかりません',
          false,
        ],
        [{ status: 503, json: { error: { code: 'unavailable', message: 'x' } } }, 'GitHub に届きませんでした', false],
        // 書く前に断られた 4xx（回数の上限など）は、何も書かれていないと伝え、読み直さない
        [{ status: 429, json: { error: { code: 'rate_limited', message: 'x' } } }, '何も書かれていません', false],
        [{ status: 500, json: { error: { code: 'internal', message: 'x' } } }, '指名し直せたか分かりません', true],
        // 2xx でも本文が読めない応答は、書かれたか分からない
        [{ status: 200, body: '{"slug":' }, '指名し直せたか分かりません', true],
        ['abort', '指名し直せたか分かりません', true],
      ];
      for (const [next, text, reloads] of cases) {
        reply = next;
        const before = lists;
        await submit.click();
        const alert = dialog.locator('.callout.is-danger[role="alert"]');
        await expect(alert).toContainText(text);
        // 欄に紐づかない失敗は、誤りを出した枠にフォーカスを移す
        await expect(alert).toBeFocused();
        if (reloads) await expect.poll(() => lists).toBeGreaterThan(before);
        else expect(lists).toBe(before);
        await expect(dialog).toBeVisible();
      }

      // ユーザー名の持ち主が変わった（入力の誤り）は、ユーザー名の欄の下で知らせ、確かめ直すまで指名できない
      reply = invalidInput('admin.login_subject', 'github_user_changed');
      await submit.click();
      await expect(dialog.getByRole('alert')).toContainText('ユーザー名の持ち主が変わりました');
      await expect(dialog.getByLabel('GitHub のユーザー名')).toBeFocused();
      await expect(submit).toBeDisabled();

      // メールアドレスの形が合わないは、メールアドレスの欄の下で知らせる
      await dialog.getByRole('radio', { name: 'Google' }).check();
      await dialog.getByLabel('Google のメールアドレス').fill('mio@');
      reply = invalidInput('admin.email', 'email_invalid');
      await submit.click();
      await expect(dialog.getByRole('alert')).toContainText('メールアドレスの形に合いません');
      await expect(dialog.getByLabel('Google のメールアドレス')).toBeFocused();
    });

    test('指名を送っている間は、入力欄と手段が読み取り専用になり、閉じる操作と「指名する」を無視し、1回しか送らない', async ({
      page,
    }) => {
      await mockList(page, [organization({ admin_status: 'none' })]);
      let requests = 0;
      const gate = deferred<void>();
      await page.route('**/api/organization-admin-reassign', async (route) => {
        requests++;
        await gate.promise;
        await route.fulfill({
          json: {
            slug: 'aoba',
            admin_login_name: 'mio.hoshino@example.com',
            invite: { url: 'http://localhost:8787/invite#x', expires_at: '2026-11-09T00:00:00.000Z' },
          },
        });
      });
      await page.goto('/operator');
      const dialog = await openReassign(page, 'あおば開発');
      await dialog.getByRole('radio', { name: 'Google' }).check();
      await dialog.getByLabel('Google のメールアドレス').fill('mio.hoshino@example.com');
      await dialog.getByRole('button', { name: '指名する', exact: true }).click();

      const sending = dialog.getByRole('button', { name: '指名しています' });
      await expect(sending).toHaveAttribute('aria-disabled', 'true');
      await expect(dialog.getByRole('status')).toHaveText('指名しています');
      await expect(dialog.getByLabel('Google のメールアドレス')).toHaveAttribute('readonly', '');
      await expect(dialog.getByRole('radio', { name: 'GitHub' })).toBeDisabled();
      await sending.click({ force: true });
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: 'やめる' }).click({ force: true });
      await expect(dialog).toBeVisible();

      await settleAfterResponse(page, 'organization-admin-reassign', () => gate.release());
      await expect(dialog.getByRole('heading', { name: 'ギルドマスターを指名しました' })).toBeVisible();
      expect(requests).toBe(1);
    });

    test('自分を指名したという応答はユーザー名の欄の下で知らせ、見つからない（404）の後は閉じると一覧を読み直す', async ({
      page,
    }) => {
      let lists = 0;
      await page.route('**/api/list-organizations', (route) => {
        lists++;
        return route.fulfill({ json: { organizations: [organization({ admin_status: 'none' })] } });
      });
      await mockGithubUser(page, TOKYO_USER);
      let reply: Parameters<Route['fulfill']>[0] = invalidInput('admin.username', 'nominee_is_operator');
      await page.route('**/api/organization-admin-reassign', (route) => route.fulfill(reply));
      await page.goto('/operator');
      const dialog = await openReassign(page, 'あおば開発');
      await dialog.getByLabel('GitHub のユーザー名').fill('alice');
      await dialog.getByRole('button', { name: '確かめる' }).click();
      const submit = dialog.getByRole('button', { name: '指名する', exact: true });
      await submit.click();
      await expect(dialog.getByRole('alert')).toContainText('この GitHub のユーザーは、あなた（運用者）のログインです');
      await expect(dialog.getByLabel('GitHub のユーザー名')).toBeFocused();
      // 確かめ直すまで指名できない
      await expect(submit).toBeDisabled();

      reply = { status: 404, json: { error: { code: 'not_found', message: 'x' } } };
      await dialog.getByRole('button', { name: '確かめる' }).click();
      await submit.click();
      await expect(dialog.locator('.callout.is-danger[role="alert"]')).toContainText(
        'この冒険者ギルドが見つかりません',
      );
      const before = lists;
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => lists).toBeGreaterThan(before);
    });

    test('ログインが切れていたら、ログインの画面に移る', async ({ page }) => {
      await mockList(page, [organization({ admin_status: 'none' })]);
      await page.route('**/api/organization-admin-reassign', (route) =>
        route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'x' } } }),
      );
      await page.goto('/operator');
      const dialog = await openReassign(page, 'あおば開発');
      await dialog.getByRole('radio', { name: 'Google' }).check();
      await dialog.getByLabel('Google のメールアドレス').fill('mio.hoshino@example.com');
      await dialog.getByRole('button', { name: '指名する', exact: true }).click();
      await expect(page).toHaveURL(/\/login\?return_to=%2Foperator/);
    });

    test('390px の幅でも、指名し直しのダイアログは横にはみ出さず、確かめるボタンは入力欄の横に残る', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mockList(page, [organization({ name: 'とても長い名前の組織'.repeat(6), admin_status: 'expired' })]);
      await page.goto('/operator');
      await page.getByRole('button', { name: /のギルドマスターを指名/ }).click();
      const dialog = page.getByRole('dialog', { name: 'ギルドマスターを指名し直す' });
      await expect(dialog).toBeVisible();
      const lead = dialog.locator('p.wrap-anywhere');
      expect(await lead.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      const input = (await dialog.getByLabel('GitHub のユーザー名').boundingBox())!;
      const button = (await dialog.getByRole('button', { name: '確かめる' }).boundingBox())!;
      const center = button.y + button.height / 2;
      expect(center).toBeGreaterThanOrEqual(input.y);
      expect(center).toBeLessThanOrEqual(input.y + input.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const sheet = (await dialog.locator('.dialog-sheet').boundingBox())!;
      expect(sheet.x).toBeGreaterThanOrEqual(0);
      expect(sheet.x + sheet.width).toBeLessThanOrEqual(390);
    });
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
    'organization-suspension-update',
    'organization-resume',
    'organization-quota-update',
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
