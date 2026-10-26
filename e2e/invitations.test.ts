// 招待の画面（/<slug>/invitations）と、組織に入れず招待だけがある人の組織の枠。
// seed の招待だけが届いた人（ヒナタ、seed/sessions.ts の invitee）には、ひばり工房のデザイン相談室への承諾待ちの招待が1件ある（seed/data.sql）。
// 本物の API で承諾するのは最初のテストだけで、承諾すると招待は残らない。ほかのテストは、承諾の後でも同じに動くよう、
// 組織の枠と招待の操作の応答を差し替える。サーバーの処理は test/invitation-response.test.ts が確かめる
import { expect, test, type Page } from '@playwright/test';
import { signIn, watchViolations } from './helpers.ts';

const DESIGN_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000404';

// 招待だけの人は organization の操作が 404 になる（組織に入れない）。ブラウザはこの 404 をコンソールに出すので除く
const expected404 = (entry: string) => !entry.includes('404 (Not Found)');
// 招待が残らなくなった人は、組織の選択の読み取りが 401 になる
const expected401 = (entry: string) => expected404(entry) && !entry.includes('401 (Unauthorized)');
const toast = (page: Page) => page.locator('.toasts:visible .toast');

type InboxInvitation = {
  invitation_id: string;
  workspace_id: string;
  workspace_name: string;
  closed: boolean;
  role: 'leader' | 'member';
  invited_by_name: string;
  invited_on: string;
};

function invitation(overrides: Partial<InboxInvitation> = {}): InboxInvitation {
  return {
    invitation_id: '019a0000-0000-7000-8000-00000000fa01',
    workspace_id: DESIGN_WORKSPACE_ID,
    workspace_name: 'デザイン相談室',
    closed: false,
    role: 'member',
    invited_by_name: 'リン',
    invited_on: '2026-10-19',
    ...overrides,
  };
}

// 招待だけの人として、ひばり工房の枠と招待の一覧を差し替える。invitations は呼ぶたびに今の値を返す。
// 招待が残っていなければ、本物と同じく組織の選択の読み取りが 401（入れる組織も招待も無い人はセッションが消える）
async function stubInvitedOnly(
  page: Page,
  state: { invitations: InboxInvitation[]; vocabulary?: 'game' | 'scrum'; theme?: string },
): Promise<void> {
  await page.route('**/api/hibari/organization', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not found' } } }),
  );
  await page.route('**/api/my-organizations', (route) =>
    state.invitations.length > 0
      ? route.fulfill({
          json: {
            organizations: [],
            invitations: [{ organization_name: 'ひばり工房', slug: 'hibari' }],
            operator: false,
          },
        })
      : route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'unauthenticated' } } }),
  );
  await page.route('**/api/hibari/invitation-list', (route) =>
    route.fulfill({
      json: {
        organization: {
          name: 'ひばり工房',
          vocabulary: state.vocabulary ?? 'game',
          theme: state.theme ?? 'simple',
        },
        invitations: state.invitations,
      },
    }),
  );
}

test.describe('招待だけが届いた人（ヒナタ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'invitee');
  });

  test('ログインすると組織の選択に届いた招待が出て、招待の画面で承諾するとそのワークスペースに入る', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('まだ入れる冒険者ギルドがありません')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '届いた招待' })).toBeVisible();
    const link = page.getByRole('link', { name: /ひばり工房/ });
    await expect(link).toContainText('承諾待ちの招待があります');
    await link.click();

    await expect(page).toHaveURL(/\/hibari\/invitations$/);
    await expect(page.getByRole('heading', { level: 1, name: '届いた招待' })).toBeVisible();
    await expect(page).toHaveTitle('届いた招待 - Scrum Guild');
    // 枠（左のメニュー）は出さない
    await expect(page.locator('.nav')).toHaveCount(0);
    const row = page.locator('.choice.is-static');
    await expect(row).toHaveCount(1);
    await expect(row.locator('b')).toHaveText('デザイン相談室');
    await expect(row).toContainText('ひばり工房・リンさんから・一般・2026-10-19');

    await page.getByRole('button', { name: 'デザイン相談室への招待を承諾する' }).click();
    await expect(page).toHaveURL(new RegExp(`/hibari/w/${DESIGN_WORKSPACE_ID}$`));
    await expect(toast(page)).toHaveText('招待を承諾しました');
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('デザイン相談室');
    // 組織の中に入ったので、枠が出る
    await expect(page.locator('.nav')).toHaveCount(1);
    expect((await collect()).filter(expected404)).toEqual([]);
  });

  test('組織の直下を開いても招待の画面になり、組織の言葉づかいとテーマが当たる。終了したワークスペースは承諾できない', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await stubInvitedOnly(page, {
      vocabulary: 'scrum',
      theme: 'medieval',
      invitations: [
        invitation({ role: 'leader' }),
        invitation({
          invitation_id: '019a0000-0000-7000-8000-00000000fa02',
          workspace_id: '019a0000-0000-7000-8000-00000000fb02',
          workspace_name: '旧サイト改修',
          closed: true,
        }),
      ],
    });
    await page.goto('/hibari');
    await expect(page).toHaveURL(/\/hibari$/);
    await expect(page.getByRole('heading', { level: 1, name: '届いた招待' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'medieval');
    // まだ入っていない組織のテーマは、属性だけで覚えない
    expect(await page.evaluate(() => localStorage.getItem('sg-theme'))).not.toBe('medieval');
    // スクラムの言葉（ワークスペース、リーダー）
    await expect(
      page.getByText('ひばり工房から届いた招待です。承諾すると、そのワークスペースに入れます。'),
    ).toBeVisible();
    const rows = page.locator('.choice.is-static');
    await expect(rows.nth(0)).toContainText('ひばり工房・リンさんから・リーダー・2026-10-19');
    await expect(rows.nth(1)).toContainText('このワークスペースは終了しているため、承諾できません。辞退はできます。');
    await expect(page.getByRole('button', { name: '旧サイト改修への招待を承諾する' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '旧サイト改修への招待を辞退する' })).toBeEnabled();
    // 組織に入れない人には、組織の画面へ戻るリンクを出さない
    await expect(page.getByRole('link', { name: /の画面へ戻る/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '組織の一覧へ' })).toBeVisible();
    expect((await collect()).filter(expected404)).toEqual([]);
  });

  test('辞退すると知らせて一覧を読み直し、最後の招待を辞退するとログインの画面に戻っても辞退したことが残る', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    const state = {
      invitations: [
        invitation(),
        invitation({
          invitation_id: '019a0000-0000-7000-8000-00000000fa02',
          workspace_id: '019a0000-0000-7000-8000-00000000fb02',
          workspace_name: '広報',
        }),
      ],
    };
    await stubInvitedOnly(page, state);
    const sent: unknown[] = [];
    await page.route('**/api/hibari/invitation-decline', (route) => {
      const body = route.request().postDataJSON() as { invitation_id: string };
      sent.push(body);
      state.invitations = state.invitations.filter((item) => item.invitation_id !== body.invitation_id);
      return route.fulfill({ json: { invitation_id: body.invitation_id } });
    });

    await page.goto('/hibari/invitations');
    await page.getByRole('button', { name: 'デザイン相談室への招待を辞退する' }).click();
    await expect(page.locator('.choice.is-static')).toHaveCount(1);
    await expect(page.locator('.choice.is-static b')).toHaveText('広報');
    await expect(toast(page)).toHaveText('招待を辞退しました');
    // 消えた行の位置に繰り上がった行の、押せる最初のボタンへフォーカスを移す
    await expect(page.getByRole('button', { name: '広報への招待を承諾する' })).toBeFocused();
    expect(sent).toEqual([{ invitation_id: '019a0000-0000-7000-8000-00000000fa01' }]);

    // 最後の招待を辞退すると組織の選択へ移り、入れる組織も招待も無いのでログインの画面へ戻る。トーストは残る
    await page.getByRole('button', { name: '広報への招待を辞退する' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(toast(page).last()).toHaveText('招待を辞退しました');
    expect((await collect()).filter(expected401)).toEqual([]);
  });

  test('承諾に失敗して招待が残らなくなったら、理由をトーストで出して組織の選択へ移る', async ({ page }) => {
    const collect = await watchViolations(page);
    const state = { invitations: [invitation()] };
    await stubInvitedOnly(page, state);
    await page.route('**/api/hibari/invitation-accept', (route) => {
      // 取り消された。読み直すと招待は残らない
      state.invitations = [];
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not found' } } });
    });
    await page.goto('/hibari/invitations');
    await page.getByRole('button', { name: 'デザイン相談室への招待を承諾する' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(toast(page)).toHaveText(
      '招待が見つかりませんでした。取り消されたか、別のアカウントに宛てた招待です。',
    );
    expect((await collect()).filter(expected401)).toEqual([]);
  });

  test('承諾に失敗すると、理由を出して一覧を読み直す', async ({ page }) => {
    const collect = await watchViolations(page);
    const state = { invitations: [invitation()] };
    await stubInvitedOnly(page, state);
    let code = 'conflict';
    await page.route('**/api/hibari/invitation-accept', (route) =>
      route.fulfill({ status: 409, json: { error: { code, message: 'conflict' } } }),
    );
    await page.goto('/hibari/invitations');
    const accept = page.getByRole('button', { name: 'デザイン相談室への招待を承諾する' });

    await accept.click();
    await expect(page.getByRole('alert')).toHaveText(
      '招待の状態が変わっていました。取り消されたか、承諾か辞退が済んでいます。',
    );
    // 終了していた。読み直した一覧では終了しているので、承諾は押せなくなる
    code = 'workspace_closed';
    state.invitations = [invitation({ closed: true })];
    await accept.click();
    await expect(page.getByRole('alert')).toHaveText('このパーティは終了したため、承諾できませんでした。');
    await expect(accept).toBeDisabled();
    // 押したボタンが押せなくなったので、同じ行の「辞退する」へフォーカスを移す
    await expect(page.getByRole('button', { name: 'デザイン相談室への招待を辞退する' })).toBeFocused();
    await expect(page).toHaveURL(/\/hibari\/invitations$/);
    expect((await collect()).filter((entry) => expected404(entry) && !entry.includes('409 (Conflict)'))).toEqual([]);
  });
});

test.describe('組織に入れる人（あおば開発のミナト）', () => {
  test('/<slug>/invitations は枠を出さずに招待の画面を出し、招待が無ければ空の状態と組織の画面へ戻るリンクを出す', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    const collect = await watchViolations(page);
    await page.goto('/aoba/invitations');
    await expect(page.getByRole('heading', { level: 1, name: '届いた招待' })).toBeVisible();
    await expect(page.locator('.nav')).toHaveCount(0);
    await expect(page.getByText('承諾待ちの招待はありません')).toBeVisible();
    await page.getByRole('link', { name: '冒険者ギルドの画面へ戻る' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(page.locator('.nav')).toHaveCount(1);
    expect(await collect()).toEqual([]);
  });
});
