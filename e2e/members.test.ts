// メンバーの画面。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発の受託開発チームは、ミナト（管理者でリーダー）とハルカ（一般）が所属し、承諾待ちの招待が1件ある（seed/data.sql）
import { expect, test } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';
const MEMBERS_PATH = `/aoba/w/${AOBA_WORKSPACE_ID}/members`;

test.describe('リーダー（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('メニューの「メンバー」から開くと、所属している人と承諾待ちの招待が出る', async ({ page }) => {
    const collect = await watchViolations(page);
    // 組織の画面のメニューには、ワークスペースの経路の項目を出さない
    await page.goto('/aoba');
    await expect(page.locator('.nav-item', { hasText: 'メンバー' })).toHaveCount(0);

    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await page.locator('.nav-item', { hasText: 'メンバー' }).click();
    await expect(page).toHaveURL(new RegExp(`${MEMBERS_PATH}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'メンバー' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('受託開発チーム');
    await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('メンバー');
    await expect(page).toHaveTitle('メンバー・受託開発チーム - Scrum Guild');

    // 頭の数字は所属、リーダー、招待中
    const tally = page.locator('.tally > div');
    await expect(tally).toHaveText(['所属 2', 'パーティリーダー 1', '招待中 1']);

    // 所属している人。リーダーが先。ロールは文字で、操作の部品は出ない
    const members = page.getByRole('table', { name: '所属している人の一覧' });
    const rows = members.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    // 名前の前に頭文字の円（その文字も td の文字に入る）
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('ミミナト');
    await expect(rows.nth(0).locator('td').nth(0).getByRole('img', { name: 'ミナト' })).toBeVisible();
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('パーティリーダー');
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('2026-10-01');
    await expect(rows.nth(1).locator('td').nth(0)).toHaveText('ハハルカ');
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('一般');
    await expect(members.locator('select, button')).toHaveCount(0);

    // 承諾待ちの招待。招待した日はワークスペースのタイムゾーン（東京）の日付
    const invitations = page.getByRole('table', { name: '承諾待ちの招待の一覧' });
    await expect(page.getByRole('heading', { level: 2, name: '承諾待ちの招待' })).toBeVisible();
    await expect(invitations.locator('tbody tr')).toHaveCount(1);
    const invitation = invitations.locator('tbody tr').first().locator('td');
    await expect(invitation).toHaveText(['sora--seed', 'GitHub', '一般', '2026-10-19', '取り消す']);

    // 招待する。組織の人数は、管理者のミナト、一般のハルカ、承諾待ちのそら の3人。ログインの手段は GitHub だけ
    await expect(page.getByRole('heading', { level: 2, name: '招待する' })).toBeVisible();
    await expect(page.locator('#members-invite').locator('..').locator('.section-hint')).toHaveText(
      '冒険者ギルドの人数 3 / 15 人',
    );
    await expect(page.getByRole('radiogroup', { name: 'ログインの手段' }).getByRole('radio')).toHaveCount(1);
    // 確かめるまで招待できない
    await expect(page.getByRole('button', { name: '招待する' })).toBeDisabled();
    expect(await collect()).toEqual([]);
  });

  test('人数が上限に達していると、理由と管理者に相談するよう出し、招待の操作を押せない', async ({ page }) => {
    await page.route('**/api/aoba/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...json, seats: { used: 15, limit: 15 } } });
    });
    await page.goto(MEMBERS_PATH);
    await expect(page.locator('.callout.is-warn')).toHaveText(
      '冒険者ギルドの人数が上限（15 人）に達しているため、招待できません。上限を上げるにはギルドマスターに相談してください。',
    );
    await expect(page.getByLabel('GitHub のユーザー名')).toBeDisabled();
    await expect(page.getByRole('button', { name: '確かめる' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '招待する' })).toBeDisabled();
  });

  test('招待を断られたら、理由をユーザー名の欄に出し、確かめ直すまで招待できない', async ({ page }) => {
    await page.route('**/api/aoba/invitee-resolve', (route) =>
      route.fulfill({
        json: {
          login_subject: '9000000000000102',
          login_name: 'haruka--seed',
          display_name: 'ハルカ',
          avatar_url: null,
        },
      }),
    );
    await page.route('**/api/aoba/invitation-create', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'already_member', message: 'x' } } }),
    );
    await page.goto(MEMBERS_PATH);
    await page.getByLabel('GitHub のユーザー名').fill('haruka--seed');
    await page.getByRole('button', { name: '確かめる' }).click();
    await expect(page.locator('.choice')).toContainText('haruka--seed');
    await page.getByRole('button', { name: '招待する' }).click();
    await expect(page.getByRole('alert')).toHaveText('この人は、もうこのパーティに所属しています。');
    await expect(page.getByLabel('GitHub のユーザー名')).toBeFocused();
    await expect(page.locator('.choice')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '招待する' })).toBeDisabled();
  });

  test('390px の幅で、長い名前（空白の無い30字以上）と長いメールアドレスは折り返し、所属の表ははみ出さず、招待の表は取り消すを右端に固定する', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const longName = 'ミナト'.repeat(12);
    const longLogin = 'minato-minato-minato-minato-minato-minato@example.com';
    await page.route('**/api/aoba/member-list', (route) =>
      route.fulfill({
        json: {
          members: [{ id: AOBA_WORKSPACE_ID, name: longName, role: 'leader', joined_on: '2026-10-01' }],
          // Google の招待は手段の列に期限か「期限切れ」が並び、その列も広がる
          invitations: [
            {
              id: 'i1',
              login_name: longLogin,
              login_provider: 'google',
              role: 'member',
              invited_on: '2026-10-19',
              expires_on: '2026-11-02',
              expired: false,
            },
            {
              id: 'i2',
              login_name: longLogin,
              login_provider: 'google',
              role: 'leader',
              invited_on: '2026-09-30',
              expires_on: '2026-10-14',
              expired: true,
            },
          ],
          seats: { used: 3, limit: 15 },
        },
      }),
    );
    await page.goto(MEMBERS_PATH);
    const invitationsTable = page.getByRole('table', { name: '承諾待ちの招待の一覧' });
    const membersTable = page.getByRole('table', { name: '所属している人の一覧' });
    await expect(invitationsTable).toContainText(longLogin);
    await expect(membersTable).toContainText(longName);
    // 所属の表は横にはみ出さず、右の列（参加日）が見える
    expect(await membersTable.evaluate((el) => el.parentElement!.scrollWidth <= el.parentElement!.clientWidth)).toBe(
      true,
    );
    await expect(page.getByText('2026-10-01')).toBeInViewport();
    // 招待の表は 390px の高さでは下にあるので、縦に送ってから見る。取り消す の列は、表が横にはみ出しても右端に固定されて見える
    // （はみ出す分は表の中の横スクロールで受ける。components.css の .is-actions）
    await invitationsTable.scrollIntoViewIfNeeded();
    for (const button of await invitationsTable.getByRole('button', { name: /への招待を取り消す$/ }).all()) {
      await expect(button).toBeInViewport();
    }
    for (const text of ['2026-11-02 まで', '期限切れ', '2026-10-19']) {
      const cell = page.getByText(text);
      await cell.scrollIntoViewIfNeeded();
      await expect(cell).toBeInViewport();
    }
  });
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('所属している人は見えて、承諾待ちの招待の欄と「招待中」の数は出ず、API も招待を返さない', async ({ page }) => {
    const collect = await watchViolations(page);
    const response = page.waitForResponse((res) => res.url().endsWith('/api/aoba/member-list'));
    await page.goto(MEMBERS_PATH);
    const body = (await (await response).json()) as { members: unknown[]; invitations: unknown; seats: unknown };
    expect(body.members).toHaveLength(2);
    expect(body.invitations).toBeNull();
    expect(body.seats).toBeNull();

    await expect(page.getByRole('heading', { level: 1, name: 'メンバー' })).toBeVisible();
    await expect(page.locator('.tally > div')).toHaveText(['所属 2', 'パーティリーダー 1']);
    await expect(page.getByRole('table', { name: '所属している人の一覧' }).locator('tbody tr')).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 2, name: '承諾待ちの招待' })).toHaveCount(0);
    await expect(page.getByText('sora--seed')).toHaveCount(0);
    // 招待の操作も出ない
    await expect(page.getByRole('heading', { level: 2, name: '招待する' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /招待する|取り消す|確かめる/ })).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('別の組織のワークスペースの ID は「見つからない」', async ({ page }) => {
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000402/members');
    await expect(page.getByRole('heading', { level: 1, name: /見つかりません/ })).toBeVisible();
  });
});

// 招待して取り消す一続き。ひばり工房の社内ツール（スクラムの言葉）で、リーダーで管理者のリンが操作する。
// e2e の Worker は本物の GitHub へ行かないので、GitHub に問い合わせる応答（invitee-resolve、invitation-create）と、
// 招待した後の member-list の読み直しは差し替える。取り消しは、seed の承諾待ちの招待（kaede--seed）に本物の API で行う。
// サーバーの処理は test/invitation.test.ts が確かめる
test.describe('リーダー（ひばり工房のリン）', () => {
  const HIBARI_MEMBERS_PATH = '/hibari/w/019a0000-0000-7000-8000-000000000402/members';

  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'otherOrg');
  });

  test('GitHub のユーザー名を確かめて招待すると承諾待ちに出て、取り消すと消える', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto(HIBARI_MEMBERS_PATH);
    const invitations = page.getByRole('table', { name: '承諾待ちの招待の一覧' });
    await expect(invitations.locator('tbody tr')).toHaveCount(1);
    await expect(invitations.locator('tbody tr').first()).toContainText('kaede--seed');

    await page.route('**/api/hibari/invitee-resolve', (route) =>
      route.fulfill({
        json: { login_subject: '9000000000000301', login_name: 'nagi--seed', display_name: '凪', avatar_url: null },
      }),
    );
    await page.getByLabel('GitHub のユーザー名').fill('nagi--seed');
    await page.getByRole('button', { name: '確かめる' }).click();
    const resolved = page.locator('.choice');
    await expect(resolved).toContainText('nagi--seed');
    await expect(resolved).toContainText('凪');
    await expect(resolved).toContainText('GitHub のユーザー ID 9000000000000301');
    await page.getByRole('radiogroup', { name: 'ロール' }).getByRole('radio', { name: 'リーダー' }).check();

    // 招待した後の読み直しに、招待した人を足して返す（本物の招待は GitHub に問い合わせるので作れない）
    let sent: unknown;
    await page.route('**/api/hibari/invitation-create', (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({
        json: { invitation_id: '019a0000-0000-7000-8000-00000000ffff', login_name: 'nagi--seed' },
      });
    });
    await page.route('**/api/hibari/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { invitations: unknown[]; seats: { used: number; limit: number } };
      json.invitations.push({
        id: '019a0000-0000-7000-8000-00000000ffff',
        login_name: 'nagi--seed',
        login_provider: 'github',
        role: 'leader',
        invited_on: '2026-10-20',
        expires_on: null,
        expired: false,
      });
      json.seats.used += 1;
      await route.fulfill({ response, json });
    });
    await page.getByRole('button', { name: '招待する' }).click();
    await expect(page.locator('.toasts:visible .toast')).toHaveText('nagi--seed を招待しました');
    expect(sent).toEqual({
      workspace_id: '019a0000-0000-7000-8000-000000000402',
      provider: 'github',
      username: 'nagi--seed',
      login_subject: '9000000000000301',
      role: 'leader',
    });
    await expect(invitations.locator('tbody tr')).toHaveCount(2);
    await expect(invitations.locator('tbody tr').nth(1).locator('td')).toHaveText([
      'nagi--seed',
      'GitHub',
      'リーダー',
      '2026-10-20',
      '取り消す',
    ]);
    // 入力は空に戻る
    await expect(page.getByLabel('GitHub のユーザー名')).toHaveValue('');
    await page.unroute('**/api/hibari/member-list');

    // seed の招待を本物の API で取り消す。読み直した一覧から消える
    await page.getByRole('button', { name: 'kaede--seed への招待を取り消す' }).click();
    await expect(page.locator('.toasts:visible .toast').last()).toHaveText('招待を取り消しました');
    await expect(page.getByText('kaede--seed')).toHaveCount(0);
    await expect(page.getByText('承諾待ちの招待はありません')).toBeVisible();
    expect(await collect()).toEqual([]);
  });
});
