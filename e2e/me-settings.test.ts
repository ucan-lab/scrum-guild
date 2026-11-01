// 自分の設定の画面の「テーマ」の節と「届いた招待」、左のメニューの招待の件数（#674）。
// テーマは、あおば開発の一般のユーザー（ハルカ、seed/sessions.ts の member）の users.theme を本物の API で書く。ほかのファイルが
// 同じ人でテーマを見ることはないが、書いたテーマはテストの終わりに「組織の既定に従う」へ戻す。
// 招待は seed に、あおば開発の一般のユーザーへ届いたものが無いので、招待の一覧（invitation-list）と組織の選択（my-organizations）の応答を差し替える。
// サーバーの承諾と辞退の処理は test/invitation-response.test.ts が確かめる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';

const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

const themeSection = (page: Page) => page.getByRole('region', { name: 'テーマ', exact: true });
const htmlTheme = (page: Page) => page.locator('html').getAttribute('data-theme');

test.describe('テーマの節（ハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('選んだ瞬間に保存して画面に当て、開き直しても続く。「組織の既定に従う」で組織の既定に戻る', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/me');
    const section = themeSection(page);
    await expect(section.getByRole('heading', { level: 2, name: 'テーマ' })).toBeVisible();
    const radios = section.getByRole('radio');
    await expect(radios).toHaveCount(6);
    const follow = section.getByRole('radio', { name: /^組織の既定に従う/ });
    await expect(follow).toBeChecked();
    // 組織の既定に従う選択肢の説明には、今の既定のテーマの名前を出す
    await expect(section.locator('label.choice').first()).toContainText('今は');
    const organizationTheme = await htmlTheme(page);

    try {
      const saved = page.waitForResponse((res) => res.url().endsWith('/api/aoba/me-theme-update') && res.ok());
      await section.getByRole('radio', { name: /^中世風/ }).check();
      // 保存を待たずに、画面へ当たる
      await expect.poll(() => htmlTheme(page)).toBe('medieval');
      expect((await saved).request().postDataJSON()).toEqual({ theme: 'medieval' });
      await expect(page.getByRole('status').filter({ hasText: 'テーマを「中世風」に変えました' })).toBeAttached();

      // 開き直しても続く（枠が読んだ自分のテーマ）
      await page.reload();
      await expect(section.getByRole('radio', { name: /^中世風/ })).toBeChecked();
      expect(await htmlTheme(page)).toBe('medieval');

      // 別の画面へ移って戻っても、選んだままに見える
      await page.locator('.nav-item', { hasText: '今日やること' }).click();
      await expect(page).toHaveURL(/\/aoba$/);
      expect(await htmlTheme(page)).toBe('medieval');
      await page.locator('.nav-item', { hasText: '自分の設定' }).click();
      await expect(themeSection(page).getByRole('radio', { name: /^中世風/ })).toBeChecked();

      // 「組織の既定に従う」を選ぶと、組織の既定に戻る
      const reset = page.waitForResponse((res) => res.url().endsWith('/api/aoba/me-theme-update') && res.ok());
      await themeSection(page)
        .getByRole('radio', { name: /^組織の既定に従う/ })
        .check();
      expect((await reset).request().postDataJSON()).toEqual({ theme: null });
      await expect.poll(() => htmlTheme(page)).toBe(organizationTheme);
      await page.reload();
      await expect(themeSection(page).getByRole('radio', { name: /^組織の既定に従う/ })).toBeChecked();
      expect(await htmlTheme(page)).toBe(organizationTheme);
    } finally {
      // 失敗してもハルカのテーマを残さない
      await page.goto('/aoba/me');
      const current = themeSection(page).getByRole('radio', { name: /^組織の既定に従う/ });
      if (!(await current.isChecked())) await current.check();
      await expect(current).toBeChecked();
      await page.waitForLoadState('networkidle');
    }
    expect(await collect()).toEqual([]);
  });

  test('保存に失敗したら、選択と画面を送る前の値に戻し、理由を画面に出す', async ({ page }) => {
    await page.route('**/api/aoba/me-theme-update', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await page.goto('/aoba/me');
    const section = themeSection(page);
    await expect(section.getByRole('radio', { name: /^組織の既定に従う/ })).toBeChecked();
    const before = await htmlTheme(page);

    // 失敗で選択がすぐ戻るので、check()（押した後に状態が変わったかを確かめる）でなく click() で押す
    await section.getByRole('radio', { name: /^現代風/ }).click();
    await expect(section.getByRole('alert')).toHaveText('テーマを変えられませんでした。もう一度試してください。');
    await expect(section.getByRole('radio', { name: /^組織の既定に従う/ })).toBeChecked();
    await expect(section.getByRole('radio', { name: /^現代風/ })).not.toBeChecked();
    expect(await htmlTheme(page)).toBe(before);

    // 次に選ぶと理由は消え、通れば保存される
    await page.unroute('**/api/aoba/me-theme-update');
    await page.route('**/api/aoba/me-theme-update', (route) => route.fulfill({ json: { theme: 'simple_dark' } }));
    await section.getByRole('radio', { name: /^シンプル（ダーク）/ }).click();
    await expect(section.getByRole('alert')).toHaveText('');
  });

  test('送っている間に選び直したら、同時に2つ送らず、送り終えてから最後に選んだ値を送る', async ({ page }) => {
    // 保存は差し替え、ハルカの users.theme を書かない。1回目の応答を止めて、その間に選び直す
    const sent: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/aoba/me-theme-update', async (route) => {
      const body = route.request().postDataJSON() as { theme: string | null };
      sent.push(body);
      if (sent.length === 1) await gate;
      await route.fulfill({ json: { theme: body.theme } });
    });
    await page.goto('/aoba/me');
    const section = themeSection(page);
    await expect(section.getByRole('radio', { name: /^組織の既定に従う/ })).toBeChecked();

    await section.getByRole('radio', { name: /^中世風/ }).check();
    await expect.poll(() => sent.length).toBe(1);
    await section.getByRole('radio', { name: /^現代風/ }).check();
    // 1回目が返るまで、2つ目は送らない。選択と画面は先に変わる
    await expect.poll(() => htmlTheme(page)).toBe('modern');
    expect(sent).toEqual([{ theme: 'medieval' }]);
    release();

    await expect.poll(() => sent).toEqual([{ theme: 'medieval' }, { theme: 'modern' }]);
    await expect(section.getByRole('radio', { name: /^現代風/ })).toBeChecked();
  });
});

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
    invitation_id: '019a0000-0000-7000-8000-00000000fb01',
    workspace_id: AOBA_WORKSPACE_ID,
    workspace_name: '保守チーム',
    closed: false,
    role: 'member',
    invited_by_name: 'リン',
    invited_on: '2026-10-19',
    ...overrides,
  };
}

// あおば開発の一般のユーザーとして、招待の一覧と組織の選択の届いた招待を差し替える。state.invitations は呼ぶたびに今の値を返す。
// 組織の選択は本物の応答に、招待のある間だけあおば開発の届いた招待を足す
async function stubInvitations(page: Page, state: { invitations: InboxInvitation[]; listStatus?: number }) {
  await page.route('**/api/aoba/invitation-list', (route) =>
    state.listStatus && state.listStatus !== 200
      ? route.fulfill({ status: state.listStatus, json: { error: { code: 'internal', message: 'x' } } })
      : route.fulfill({
          json: { organization: { name: 'あおば開発', theme: 'simple' }, invitations: state.invitations },
        }),
  );
  await page.route('**/api/my-organizations', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { invitations: { organization_name: string; slug: string }[] };
    body.invitations =
      state.invitations.length > 0
        ? [{ organization_name: 'あおば開発', slug: 'aoba' }]
        : body.invitations.filter((item) => item.slug !== 'aoba');
    await route.fulfill({ response, json: body });
  });
}

const navItem = (page: Page) => page.locator('.nav-item', { hasText: '自分の設定' });

test.describe('届いた招待（ハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('招待が届いていると、メニューの「自分の設定」に件数が付き、畳むと点になる。招待が無ければ何も付かない', async ({
    page,
  }) => {
    const state = {
      invitations: [invitation(), invitation({ invitation_id: '019a0000-0000-7000-8000-00000000fb02' })],
    };
    await stubInvitations(page, state);
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect(navItem(page).locator('.nav-badge')).toHaveText('招待 2');
    await expect(navItem(page)).toContainText('、届いた招待 2件');
    await expect(navItem(page).locator('.nav-item-invite')).toBeHidden();

    // 畳んだ列では件数を隠し、点を出す。項目の名前には件数が残る
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'メニューを畳む' }).click();
    await expect(navItem(page).locator('.nav-item-invite')).toBeVisible();
    await expect(navItem(page).locator('.nav-badge')).toBeHidden();
    await page.getByRole('button', { name: 'メニューを広げる' }).click();

    state.invitations = [];
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
    await expect(navItem(page).locator('.nav-badge')).toHaveCount(0);
    await expect(navItem(page).locator('.nav-item-invite')).toHaveCount(0);
  });

  test('自分の設定に招待が並び、辞退すると一覧とメニューの件数が減る。最後の1件を辞退すると何も出ない', async ({
    page,
  }) => {
    const first = invitation();
    const second = invitation({
      invitation_id: '019a0000-0000-7000-8000-00000000fb02',
      workspace_name: '改善チーム',
      role: 'leader',
    });
    const state = { invitations: [first, second] };
    await stubInvitations(page, state);
    await page.route('**/api/aoba/invitation-decline', async (route) => {
      const { invitation_id } = route.request().postDataJSON() as { invitation_id: string };
      state.invitations = state.invitations.filter((item) => item.invitation_id !== invitation_id);
      await route.fulfill({ json: { invitation_id } });
    });
    const collect = await watchViolations(page);
    await page.goto('/aoba/me');
    await expect(page.getByRole('heading', { level: 1, name: '自分の設定' })).toBeVisible();

    const rows = page.locator('.callout.is-info[data-invitation-row]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(
      'あおば開発のリンさんから「保守チーム」への招待が届いています（一般、2026-10-19）。',
    );
    await expect(rows.last()).toContainText('「改善チーム」への招待が届いています（リーダー、2026-10-19）。');
    await expect(navItem(page).locator('.nav-badge')).toHaveText('招待 2');
    await expect(page.getByRole('button', { name: '保守チームへの招待を承諾する' })).toBeVisible();

    await page.getByRole('button', { name: '保守チームへの招待を辞退する' }).click();
    await expect(page.locator('.toasts:visible .toast')).toContainText('招待を辞退しました');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('「改善チーム」');
    await expect(navItem(page).locator('.nav-badge')).toHaveText('招待 1');
    // 残った招待のボタンへフォーカスが移る
    await expect(page.getByRole('button', { name: '改善チームへの招待を承諾する' })).toBeFocused();

    await page.getByRole('button', { name: '改善チームへの招待を辞退する' }).click();
    await expect(rows).toHaveCount(0);
    await expect(navItem(page).locator('.nav-badge')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: '自分の設定' })).toBeFocused();
    // 招待が無くなっても、ほかの節は残る
    await expect(themeSection(page)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '経験値の明細' })).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('承諾すると、そのワークスペースへ移る。終了したワークスペースの招待は承諾できず、辞退はできる', async ({
    page,
  }) => {
    const open = invitation();
    const closed = invitation({
      invitation_id: '019a0000-0000-7000-8000-00000000fb03',
      workspace_name: '終了した相談室',
      closed: true,
    });
    const state = { invitations: [open, closed] };
    await stubInvitations(page, state);
    await page.route('**/api/aoba/invitation-accept', (route) => {
      state.invitations = [];
      return route.fulfill({ json: { workspace_id: AOBA_WORKSPACE_ID } });
    });
    await page.goto('/aoba/me');
    await expect(page.locator('.callout.is-info[data-invitation-row]')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '終了した相談室への招待を承諾する' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '終了した相談室への招待を辞退する' })).toBeEnabled();
    await expect(page.getByText('終了しているため、承諾できません。辞退はできます。')).toBeVisible();

    await page.getByRole('button', { name: '保守チームへの招待を承諾する' }).click();
    await expect(page).toHaveURL(new RegExp(`/aoba/w/${AOBA_WORKSPACE_ID}$`));
    await expect(page.locator('.toasts:visible .toast')).toContainText('招待を承諾しました');
  });

  test('承諾が失敗したら理由を出して一覧を読み直す。一覧が読めないときは失敗とやり直しを出し、ほかの節は残る', async ({
    page,
  }) => {
    const state: { invitations: InboxInvitation[]; listStatus?: number } = { invitations: [invitation()] };
    await stubInvitations(page, state);
    await page.route('**/api/aoba/invitation-accept', (route) => {
      state.invitations = [];
      return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'x' } } });
    });
    await page.goto('/aoba/me');
    await page.getByRole('button', { name: '保守チームへの招待を承諾する' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '招待の状態が変わっていました。' })).toBeVisible();
    await expect(page.locator('.callout.is-info[data-invitation-row]')).toHaveCount(0);

    // 一覧が読めない（本文の失敗の囲み。ほかの節は生かす）
    state.listStatus = 500;
    await page.reload();
    await expect(page.getByText('届いた招待を読み込めませんでした')).toBeVisible();
    await expect(themeSection(page)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '経験値の明細' })).toBeVisible();
    state.listStatus = 200;
    state.invitations = [invitation()];
    await page.getByRole('button', { name: 'もう一度試す（届いた招待）' }).click();
    await expect(page.locator('.callout.is-info[data-invitation-row]')).toHaveCount(1);
    await expect(page.getByText('届いた招待を読み込めませんでした')).toHaveCount(0);
  });
});
