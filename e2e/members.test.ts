// メンバーの画面。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発の受託開発チームは、ミナト（管理者でリーダー）とハルカ（一般）が所属し、承諾待ちの招待が1件ある（seed/data.sql）
import type { Page } from '@playwright/test';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, expectFocusReturned, expectModalFocus, signIn, watchViolations } from './helpers.ts';
import { E2E_GOOGLE_INVITE_EMAIL, removeE2eGoogleInvitations, restoreKaedeInvitation } from './local-d1.ts';
import { rewriteOperation } from './operations.ts';

const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';
const HARUKA_USER_ID = '019a0000-0000-7000-8000-000000000302';
const MEMBERS_PATH = `/aoba/w/${AOBA_WORKSPACE_ID}/members`;
// アバターのホストへの要求に返す 1px の PNG（e2e/operator.test.ts と同じ）
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

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

    // 所属している人。リーダーが先。リーダーと管理者には、ロールの選択欄と、自分の行の「抜ける」、他人の行の「外す」
    const members = page.getByRole('table', { name: '所属している人の一覧' });
    const rows = members.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    // 名前の前に頭文字の円（その文字も td の文字に入る）
    // 名前の後ろにレベルの小さい紋章（数字だけ。ほかのファイルの e2e がタスクを完了にすると上がりうる）
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText(/^ミミナト\d+$/);
    await expect(rows.nth(0).locator('.emblem.is-sm')).toHaveAttribute('aria-label', /^レベル \d+$/);
    // 名前は横の文字が読むので、アバターは読み上げから外す
    const avatar = rows.nth(0).locator('td').nth(0).locator('.avatar');
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('combobox', { name: 'ミナトのロール' })).toHaveValue('leader');
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('2026-10-01');
    await expect(rows.nth(0).getByRole('button')).toHaveText('抜ける');
    await expect(rows.nth(0).getByRole('button')).toHaveAccessibleName('受託開発チームから抜ける');
    await expect(rows.nth(1).locator('td').nth(0)).toHaveText(/^ハハルカ\d+$/);
    await expect(page.getByRole('combobox', { name: 'ハルカのロール' })).toHaveValue('member');
    await expect(page.getByRole('combobox', { name: 'ハルカのロール' }).locator('option')).toHaveText([
      'パーティリーダー',
      '一般',
    ]);
    await expect(rows.nth(1).getByRole('button', { name: 'ハルカを外す' })).toHaveText('外す');
    await expect(page.locator('.action-note')).toHaveText(
      '外すと、その人の未完了のクエストは担当なしに戻ります。完了の記録と経験値は残ります。',
    );

    // 承諾待ちの招待。招待した日はワークスペースのタイムゾーン（東京）の日付
    const invitations = page.getByRole('table', { name: '承諾待ちの招待の一覧' });
    await expect(page.getByRole('heading', { level: 2, name: '承諾待ちの招待' })).toBeVisible();
    await expect(invitations.locator('tbody tr')).toHaveCount(1);
    const invitation = invitations.locator('tbody tr').first().locator('td');
    await expect(invitation).toHaveText(['sora--seed', 'GitHub', '一般', '2026-10-19', '取り消す']);

    // 招待する。組織の人数は、管理者のミナト、一般のハルカ、承諾待ちのそら の3人。ログインの手段は GitHub（既定）と Google
    await expect(page.getByRole('heading', { level: 2, name: '招待する' })).toBeVisible();
    await expect(page.locator('#members-invite').locator('..').locator('.section-hint')).toHaveText(
      '冒険者ギルドの人数 3 / 15 人',
    );
    const vias = page.getByRole('radiogroup', { name: 'ログインの手段' }).getByRole('radio');
    await expect(vias).toHaveCount(2);
    await expect(page.getByRole('radio', { name: 'GitHub' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Google' })).not.toBeChecked();
    // 確かめるまで招待できない
    await expect(page.getByRole('button', { name: '招待する' })).toBeDisabled();
    expect(await collect()).toEqual([]);
  });

  test('人数が上限に達していると、理由と管理者に相談するよう出し、まだ数えられていない人は招待できず、数えられている人は招待できる', async ({
    page,
  }) => {
    await page.route('**/api/aoba/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...json, seats: { used: 15, limit: 15 } } });
    });
    let counted = false;
    await page.route('**/api/aoba/invitee-resolve', (route) =>
      route.fulfill({
        json: {
          login_subject: counted ? '9000000000000102' : '9000000000000401',
          login_name: counted ? 'haruka--seed' : 'tsumugi--seed',
          display_name: null,
          avatar_url: null,
          already_counted: counted,
        },
      }),
    );
    await page.goto(MEMBERS_PATH);
    await expect(page.locator('.callout.is-warn')).toHaveText(
      '冒険者ギルドの人数が上限（15 人）に達しているため、新しい人は招待できません。すでに冒険者ギルドにいる人は招待できます。上限を上げるにはギルドマスターに相談してください。',
    );
    // 確かめることはできる
    const username = page.getByLabel('GitHub のユーザー名');
    const invite = page.getByRole('button', { name: '招待する' });
    await expect(username).toBeEnabled();
    await expect(page.getByRole('button', { name: '確かめる' })).toBeEnabled();
    await expect(invite).toBeDisabled();

    // まだ数えられていない人は、理由を添えて招待できない
    await username.fill('tsumugi--seed');
    await page.getByRole('button', { name: '確かめる' }).click();
    await expect(page.locator('.choice')).toContainText('tsumugi--seed');
    await expect(invite).toBeDisabled();
    await expect(invite).toHaveAccessibleDescription(
      'この人はまだ冒険者ギルドの人数に数えられていないため、上限に達している間は招待できません。',
    );

    // すでに数えられている人は招待できる
    counted = true;
    await username.fill('haruka--seed');
    await page.getByRole('button', { name: '確かめる' }).click();
    await expect(page.locator('.choice')).toContainText('haruka--seed');
    await expect(invite).toBeEnabled();
  });

  test('招待の送信が上限で断られたら、上限の枠を知らせてフォーカスを移す', async ({ page }) => {
    await page.route('**/api/aoba/invitee-resolve', (route) =>
      route.fulfill({
        json: {
          login_subject: '9000000000000401',
          login_name: 'tsumugi--seed',
          display_name: null,
          avatar_url: null,
          already_counted: false,
        },
      }),
    );
    await page.route('**/api/aoba/invitation-create', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'member_limit_reached', message: 'x' } } }),
    );
    await page.goto(MEMBERS_PATH);
    await page.getByLabel('GitHub のユーザー名').fill('tsumugi--seed');
    await page.getByRole('button', { name: '確かめる' }).click();
    await expect(page.locator('.choice')).toContainText('tsumugi--seed');
    await page.getByRole('button', { name: '招待する' }).click();
    const alert = page.getByRole('alert').filter({ hasText: '上限' });
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused();
    await expect(page.getByRole('button', { name: '招待する' })).toBeDisabled();
    // 失敗した後の読み上げの領域に「確かめました」を残さない
    await expect(page.locator('.panel [role="status"]')).toHaveText('');
  });

  test('招待を断られたら、理由をユーザー名の欄に出し、確かめ直すまで招待できない', async ({ page }) => {
    await page.route('**/api/aoba/invitee-resolve', (route) =>
      route.fulfill({
        json: {
          login_subject: '9000000000000102',
          login_name: 'haruka--seed',
          display_name: 'ハルカ',
          avatar_url: null,
          already_counted: true,
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

  test('Google の招待の失敗は、メールアドレスの欄か送信の下に出し、書かれたか分からないときは新しい URL の出し方を添える', async ({
    page,
  }) => {
    const responses = [
      { status: 409, json: { error: { code: 'already_invited', message: 'x' } } },
      // 到達しない応答（Google の招待で invite が null）も、失敗として出す
      { status: 200, json: { invitation_id: '019a0000-0000-7000-8000-00000000fffe', login_name: 'x', invite: null } },
      { status: 500, json: { error: { code: 'internal', message: 'x' } } },
    ];
    await page.route('**/api/aoba/invitation-create', (route) => route.fulfill(responses.shift()!));
    await page.goto(MEMBERS_PATH);
    await page.getByRole('radio', { name: 'Google' }).check();
    const email = page.getByLabel('Google のメールアドレス');
    const invite = page.getByRole('button', { name: '招待する' });

    await email.fill(E2E_GOOGLE_INVITE_EMAIL);
    await invite.click();
    await expect(page.locator('#invite-email-error')).toHaveText(
      'この人には、このパーティへの承諾待ちの招待があります。',
    );
    await expect(email).toBeFocused();

    await email.fill(E2E_GOOGLE_INVITE_EMAIL);
    await invite.click();
    const callout = page.locator('.panel .callout.is-danger');
    await expect(callout).toHaveText('招待できませんでした。もう一度試してください。');
    await expect(callout).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await invite.click();
    await expect(callout).toHaveText(
      '招待できたか分かりません。承諾待ちに出ていても、招待の URL はもう出せません。もう一度招待すると新しい招待の URL が出て、前の URL は使えなくなります。',
    );
  });

  test('Google の招待が上限で断られても、GitHub で確かめた数えられている人は招待できるまま', async ({ page }) => {
    await page.route('**/api/aoba/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...json, seats: { used: 15, limit: 15 } } });
    });
    await page.route('**/api/aoba/invitee-resolve', (route) =>
      route.fulfill({
        json: {
          login_subject: '9000000000000102',
          login_name: 'haruka--seed',
          display_name: null,
          avatar_url: null,
          already_counted: true,
        },
      }),
    );
    await page.route('**/api/aoba/invitation-create', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'member_limit_reached', message: 'x' } } }),
    );
    await page.goto(MEMBERS_PATH);
    await page.getByLabel('GitHub のユーザー名').fill('haruka--seed');
    await page.getByRole('button', { name: '確かめる' }).click();
    await expect(page.locator('.choice')).toContainText('haruka--seed');
    const invite = page.getByRole('button', { name: '招待する' });
    await expect(invite).toBeEnabled();

    // Google では、同じアドレスの承諾待ちがある人だけを数えられている人として扱うことを、上限の枠に添える
    await page.getByRole('radio', { name: 'Google' }).check();
    await expect(page.locator('.panel .callout.is-warn')).toContainText(
      'Google の招待では、同じメールアドレスへの承諾待ちの招待がある人だけを、すでに数えられている人として扱います。',
    );
    await page.getByLabel('Google のメールアドレス').fill(E2E_GOOGLE_INVITE_EMAIL);
    await invite.click();
    await expect(page.getByRole('alert').filter({ hasText: '上限' })).toBeFocused();

    await page.getByRole('radio', { name: 'GitHub' }).check();
    await expect(page.locator('.choice')).toContainText('haruka--seed');
    await expect(invite).toBeEnabled();
  });

  test('アバターのある人は画像、無い人は頭文字の円で出る', async ({ page }) => {
    const collect = await watchViolations(page);
    // seed のログインはアバターを持たないので、member-list の応答にアバターを足し、アバターのホストへは出ずに画像を差し替える
    await page.route('**/api/aoba/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { members: { name: string }[] };
      await route.fulfill({
        response,
        json: {
          ...json,
          members: json.members.map((member) => ({
            ...member,
            avatar_url: member.name === 'ミナト' ? 'https://avatars.githubusercontent.com/u/7300001' : null,
          })),
        },
      });
    });
    await page.route('https://avatars.githubusercontent.com/**', (route) =>
      route.fulfill({ body: PIXEL, contentType: 'image/png' }),
    );
    await page.goto(MEMBERS_PATH);
    const rows = page.getByRole('table', { name: '所属している人の一覧' }).locator('tbody tr');
    const minato = rows.nth(0).locator('.avatar');
    await expect(minato.locator('img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/7300001');
    await expect(minato.locator('img')).toBeVisible();
    // 画像のある人は頭文字を出さない（名前の後ろはレベルの紋章の数字）
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText(/^ミナト\d+$/);
    const haruka = rows.nth(1).locator('.avatar');
    await expect(haruka).toHaveText('ハ');
    await expect(haruka.locator('img')).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  // seed の所属はほかのファイルも数えるので、外す API と外した後の一覧は差し替える（サーバーの処理は test/membership.test.ts が確かめる）
  test('「外す」は確かめのダイアログを挟んで送り、外した人を一覧から消してトーストで知らせる', async ({ page }) => {
    const collect = await watchViolations(page);
    let sent: unknown = null;
    await page.route('**/api/aoba/membership-leave', (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ json: { user_id: HARUKA_USER_ID } });
    });
    await page.route('**/api/aoba/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { members: { id: string }[] };
      const members = sent === null ? json.members : json.members.filter((member) => member.id !== HARUKA_USER_ID);
      await route.fulfill({ response, json: { ...json, members } });
    });
    await page.goto(MEMBERS_PATH);
    const rows = page.getByRole('table', { name: '所属している人の一覧' }).locator('tbody tr');
    await expect(rows).toHaveCount(2);

    // 確かめのダイアログ（ConfirmDialog）も、開くと中にフォーカスが入り、Esc で閉じると押したボタンへ戻る。送らない
    const remove = page.getByRole('button', { name: 'ハルカを外す' });
    const dialog = page.getByRole('dialog', { name: 'ハルカを外しますか' });
    await expectModalFocus(page, { opener: remove, modal: dialog });
    expect(sent).toBeNull();

    // やめると送らない
    await remove.click();
    await expect(dialog).toContainText(
      'ハルカはパーティから外れます。担当していた未完了のクエストは担当なしに戻ります。完了の記録と経験値は残ります。戻すには、もう一度招待します。',
    );
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, remove);
    expect(sent).toBeNull();

    await remove.click();
    await dialog.getByRole('button', { name: '外す' }).click();
    await expect(page.locator('.toasts:visible .toast')).toHaveText('ハルカを外しました');
    expect(sent).toEqual({ workspace_id: AOBA_WORKSPACE_ID, user_id: HARUKA_USER_ID });
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 2, name: '所属している人' })).toBeFocused();
    expect(await collect()).toEqual([]);
  });

  test('外すのに失敗したら同じ行のボタンへフォーカスを戻し、自分の離脱が 404（先に抜けていた）なら抜けたのと同じく組織のトップへ移る', async ({
    page,
  }) => {
    await page.route('**/api/aoba/membership-leave', (route) => {
      const body = route.request().postDataJSON() as { user_id: string };
      return body.user_id === HARUKA_USER_ID
        ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } })
        : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'x' } } });
    });
    await page.goto(MEMBERS_PATH);
    const remove = page.getByRole('button', { name: 'ハルカを外す' });
    await remove.click();
    await page.getByRole('dialog', { name: 'ハルカを外しますか' }).getByRole('button', { name: '外す' }).click();
    await expect(page.locator('.toasts:visible .toast')).toHaveText(
      'メンバーを外せませんでした。もう一度試してください。',
    );
    await expect(page.getByRole('dialog', { name: 'ハルカを外しますか' })).toBeHidden();
    await expectFocusReturned(page, remove);

    // ミナトは受託開発チームの唯一のリーダーなので、リーダーがいなくなることを添える
    await page.getByRole('button', { name: '受託開発チームから抜ける' }).click();
    const dialog = page.getByRole('dialog', { name: '受託開発チームから抜けますか' });
    await expect(dialog).toContainText(
      'このパーティのパーティリーダーがいなくなります。新しいパーティリーダーはギルドマスターが任命します。',
    );
    await dialog.getByRole('button', { name: '抜ける' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(page.locator('.toasts:visible .toast').last()).toHaveText('受託開発チームから抜けました');
  });

  // 一般のメンバーが別のタブで先に抜けていたときは、登録の関数の member の権限で 403 になる。それも抜けたのと同じく扱う
  test('自分の離脱が 403（先に抜けていた）でも、抜けたのと同じく組織のトップへ移る', async ({ page }) => {
    await page.route('**/api/aoba/membership-leave', (route) =>
      route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'x' } } }),
    );
    await page.goto(MEMBERS_PATH);
    await page.getByRole('button', { name: '受託開発チームから抜ける' }).click();
    await page
      .getByRole('dialog', { name: '受託開発チームから抜けますか' })
      .getByRole('button', { name: '抜ける' })
      .click();
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(page.locator('.toasts:visible .toast').last()).toHaveText('受託開発チームから抜けました');
  });

  test('他人の唯一のリーダーを一般に戻すときも、リーダーがいなくなることを確かめ、やめると送らずに戻す', async ({
    page,
  }) => {
    let called = false;
    await page.route('**/api/aoba/membership-role-update', (route) => {
      called = true;
      return route.abort();
    });
    // ハルカだけがリーダーの一覧にする（管理者のミナトは一般でも付け替えられる）
    await page.route('**/api/aoba/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { members: { id: string; role: string }[] };
      const members = json.members.map((member) => ({
        ...member,
        role: member.id === HARUKA_USER_ID ? 'leader' : 'member',
      }));
      await route.fulfill({ response, json: { ...json, members } });
    });
    await page.goto(MEMBERS_PATH);
    const role = page.getByRole('combobox', { name: 'ハルカのロール' });
    await expect(role).toHaveValue('leader');
    await role.selectOption('member');
    const dialog = page.getByRole('dialog', { name: 'ハルカを一般に戻しますか' });
    await expect(dialog).toContainText(
      'ハルカは一般に戻り、ロールの付け替え、招待、冒険者を外すことができなくなります。',
    );
    await expect(dialog).toContainText(
      'このパーティのパーティリーダーがいなくなります。新しいパーティリーダーはギルドマスターが任命します。',
    );
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expect(role).toHaveValue('leader');
    expect(called).toBe(false);
  });

  test('ロールの選択欄で付け替え、先に変わっていて断られたら、トーストで知らせて今の値に戻す', async ({ page }) => {
    const sent: unknown[] = [];
    let reply: { status: number; json: unknown } = { status: 200, json: {} };
    let harukaRole = 'member';
    await page.route('**/api/aoba/membership-role-update', (route) => {
      const body = route.request().postDataJSON() as { role: string };
      sent.push(body);
      if (reply.status === 200) harukaRole = body.role;
      return route.fulfill({ status: reply.status, json: reply.json });
    });
    await page.route('**/api/aoba/member-list', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { members: { id: string; role: string }[] };
      const members = json.members.map((member) =>
        member.id === HARUKA_USER_ID ? { ...member, role: harukaRole } : member,
      );
      await route.fulfill({ response, json: { ...json, members } });
    });
    await page.goto(MEMBERS_PATH);
    const role = page.getByRole('combobox', { name: 'ハルカのロール' });

    reply = { status: 200, json: { user_id: HARUKA_USER_ID, role: 'leader' } };
    await role.selectOption('leader');
    await expect(page.locator('.toasts:visible .toast')).toHaveText('ハルカをパーティリーダーにしました');
    expect(sent).toEqual([{ workspace_id: AOBA_WORKSPACE_ID, user_id: HARUKA_USER_ID, role: 'leader' }]);
    await expect(page.locator('.tally > div').nth(1)).toHaveText('パーティリーダー 2');
    await expect(role).toHaveValue('leader');

    reply = { status: 409, json: { error: { code: 'conflict', message: 'x' } } };
    // 断られた後の一覧の読み直しを待ってから終える（読み直しが壊れても通らないように）。
    // 付け替えた後の読み直しは、上の tally が変わった時点で終わっているので、待つのは 409 の後の読み直し
    const reloaded = page.waitForResponse('**/api/aoba/member-list');
    await role.selectOption('member');
    await Promise.all([
      expect(page.locator('.toasts:visible .toast').last()).toHaveText(
        '冒険者のロールが先に変わっていました。一覧を読み直しました。',
      ),
      reloaded,
    ]);
    await expect(role).toHaveValue('leader');
  });

  // 本物の API で、作ったワークスペースのロールを付け替え、抜ける（seed の所属は変えない）
  test('自分で作ったワークスペースで、自分を一般に戻してリーダーに戻し、抜けると組織のトップへ移る', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    const name = `名簿確認チーム${Date.now() % 100000}`;
    await createWorkspace(page, name, 'game');
    await page.goto(`${new URL(page.url()).pathname}/members`);
    const role = page.getByRole('combobox', { name: 'ミナトのロール' });
    await expect(role).toHaveValue('leader');

    // 管理者は一般に戻しても付け替えられるが、唯一のリーダーなので、リーダーがいなくなることを確かめる。0人になっても止めない
    await role.selectOption('member');
    const demote = page.getByRole('dialog', { name: '自分を一般に戻しますか' });
    await expect(demote).toHaveText(
      /パーティリーダーがいなくなります。新しいパーティリーダーはギルドマスターが任命します。/,
    );
    // 管理者には「付け替えができなくなる」は出さない
    await expect(demote).not.toContainText('できなくなります');
    await demote.getByRole('button', { name: '一般に戻す' }).click();
    await expect(page.locator('.toasts:visible .toast')).toHaveText('ミナトを一般にしました');
    await expect(page.locator('.tally > div').nth(1)).toHaveText('パーティリーダー 0');
    await expect(role).toHaveValue('member');
    await role.selectOption('leader');
    await expect(page.locator('.toasts:visible .toast').last()).toHaveText('ミナトをパーティリーダーにしました');
    await expect(page.locator('.tally > div').nth(1)).toHaveText('パーティリーダー 1');

    await page.getByRole('button', { name: `${name}から抜ける` }).click();
    const dialog = page.getByRole('dialog', { name: `${name}から抜けますか` });
    await expect(dialog).toContainText('担当していた未完了のクエストは担当なしに戻ります。');
    await dialog.getByRole('button', { name: '抜ける' }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(page.locator('.toasts:visible .toast').last()).toHaveText(`${name}から抜けました`);
    // 管理者は所属していなくても開ける。所属している人はいない
    await page.goBack();
    await expect(page.getByText('所属している人はいません')).toBeVisible();
    expect(await collect()).toEqual([]);
  });

  test('終了したワークスペースでは、ロールの選択欄も外す、抜けるも出さない', async ({ page }) => {
    await page.route('**/api/aoba/workspace', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...json, closed_at: '2026-10-25T00:00:00.000Z' } });
    });
    await page.goto(MEMBERS_PATH);
    const members = page.getByRole('table', { name: '所属している人の一覧' });
    await expect(members.locator('tbody tr')).toHaveCount(2);
    await expect(members.locator('tbody tr').nth(0).locator('td').nth(1)).toHaveText('パーティリーダー');
    await expect(members.locator('select, button')).toHaveCount(0);
    await expect(page.locator('.action-note')).toHaveCount(0);
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
          members: [
            {
              id: AOBA_WORKSPACE_ID,
              name: longName,
              role: 'leader',
              joined_on: '2026-10-01',
              avatar_url: null,
              level: 12,
            },
          ],
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
    // 行の操作があるので、狭い幅では1行を縦に積み、ロールの選択欄と「外す」も表の中に収まる
    await expect(page.getByRole('combobox', { name: `${longName}のロール` })).toBeInViewport();
    await expect(page.getByRole('button', { name: `${longName}を外す` })).toBeInViewport();
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

  // 組織の枠の応答のうち、ハルカの所属するワークスペースを、受託開発チームと others だけにする。
  // ほかのファイルの e2e（e2e/workspace.test.ts の作成）がハルカをリーダーにしたワークスペースを足すので、seed の所属の数に頼らない
  async function setOwnWorkspaces(page: Page, others: OutputOf<typeof organizationInfo>['workspaces']): Promise<void> {
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
      ...output,
      workspaces: [...output.workspaces.filter((item) => item.id === AOBA_WORKSPACE_ID), ...others],
    }));
  }

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
    const rows = page.getByRole('table', { name: '所属している人の一覧' }).locator('tbody tr');
    await expect(rows).toHaveCount(2);
    // ロールは文字で、自分の行の「抜ける」だけを出す（ロールの選択欄、外す、表の下の注意は出ない）
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('パーティリーダー');
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('一般');
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
    await expect(rows.nth(1).getByRole('button')).toHaveText('抜ける');
    await expect(page.getByRole('button', { name: /を外す$/ })).toHaveCount(0);
    await expect(page.locator('.action-note')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: '承諾待ちの招待' })).toHaveCount(0);
    await expect(page.getByText('sora--seed')).toHaveCount(0);
    // 招待の操作も出ない
    await expect(page.getByRole('heading', { level: 2, name: '招待する' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /招待する|取り消す|確かめる/ })).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('「抜ける」は確かめのダイアログを挟み、ほかに所属が無ければ組織に入れなくなると知らせる。やめると送らない', async ({
    page,
  }) => {
    let called = false;
    await page.route('**/api/aoba/membership-leave', (route) => {
      called = true;
      return route.abort();
    });
    await setOwnWorkspaces(page, []);
    await page.goto(MEMBERS_PATH);
    const leave = page.getByRole('button', { name: '受託開発チームから抜ける' });
    await leave.click();
    const dialog = page.getByRole('dialog', { name: '受託開発チームから抜けますか' });
    await expect(dialog).toContainText(
      'ほかに所属しているパーティが無いので、抜けると、この冒険者ギルドに入れなくなります。',
    );
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, leave);
    expect(called).toBe(false);
  });

  test('ほかにも所属していれば、「抜ける」のダイアログは組織に入れなくなるとは知らせない', async ({ page }) => {
    await setOwnWorkspaces(page, [
      { id: '019a0000-0000-7000-8000-00000000fff1', name: '社内ツール改善', role: 'leader' },
    ]);
    await page.goto(MEMBERS_PATH);
    await page.getByRole('button', { name: '受託開発チームから抜ける' }).click();
    const dialog = page.getByRole('dialog', { name: '受託開発チームから抜けますか' });
    await expect(dialog).toContainText('担当していた未完了のクエストは担当なしに戻ります。');
    await expect(dialog).not.toContainText('入れなくなります');
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toBeHidden();
  });

  test('別の組織のワークスペースの ID は「見つからない」', async ({ page }) => {
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000402/members');
    await expect(page.getByRole('heading', { level: 1, name: /見つかりません/ })).toBeVisible();
  });
});

// 招待して取り消す一続き。ひばり工房の社内ツール（スクラムの言葉）で、リーダーで管理者のリンが操作する。
// e2e の Worker は本物の GitHub へ行かないので、GitHub に問い合わせる応答（invitee-resolve、invitation-create）と、
// 招待した後の member-list の読み直しは差し替える。取り消しは、seed の承諾待ちの招待（kaede--seed）に本物の API で行い、
// テストの後で承諾待ちに戻す（取り消しを戻す操作は無いので、手元の D1 に直に書く。e2e/local-d1.ts）。
// Google の招待は GitHub に問い合わせないので本物の API で作り、テストの後で消す（招待を消す操作は無いので、同じく手元の D1 に直に書く）。
// サーバーの処理は test/invitation.test.ts が確かめる
test.describe('リーダー（ひばり工房のリン）', () => {
  const HIBARI_MEMBERS_PATH = '/hibari/w/019a0000-0000-7000-8000-000000000402/members';

  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'otherOrg');
  });

  test.afterEach(async () => {
    await restoreKaedeInvitation();
    await removeE2eGoogleInvitations();
  });

  test('Google のメールアドレスで招待すると招待の URL をダイアログで出し、閉じると承諾待ちに Google と期限が出る。招待し直すと新しい URL が出て、前の招待は消える', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const collect = await watchViolations(page);
    await page.goto(HIBARI_MEMBERS_PATH);
    const invitations = page.getByRole('table', { name: '承諾待ちの招待の一覧' });
    await expect(invitations.locator('tbody tr')).toHaveCount(1);

    // Google を選ぶと、メールアドレスの欄にし、確かめる手順は出さない
    await page.getByRole('radio', { name: 'Google' }).check();
    const email = page.getByLabel('Google のメールアドレス');
    await expect(email).toBeVisible();
    await expect(page.getByLabel('GitHub のユーザー名')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '確かめる' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '招待する' })).toBeDisabled();
    await expect(
      page.locator('.panel .field-hint', { hasText: 'Scrum Guild は招待をメールで送りません。' }),
    ).toHaveText(
      /^Scrum Guild は招待をメールで送りません。Google の招待は、招待したときに出る招待の URL（14日で切れます）を本人に伝えてください。GitHub の招待は、次の冒険者ギルドの URL を伝えてください。\s*http:\/\/localhost:\d+\/hibari\/$/,
    );

    // 形の合わないアドレスは欄の下に出す
    await email.fill('nagisa.e2e');
    await email.press('Enter');
    await expect(page.locator('#invite-email-error')).toHaveText(
      'メールアドレスの形に合いません。英数字などの ASCII の文字だけで、本人が Google に登録した綴りのまま入れてください。',
    );
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    // 手段を切り替えると、入力の誤りを消す
    await page.getByRole('radio', { name: 'GitHub' }).check();
    await page.getByRole('radio', { name: 'Google' }).check();
    await expect(page.locator('#invite-email-error')).toHaveCount(0);

    // 大文字を混ぜても、そろえたアドレスで招待する。Enter でも招待する
    await email.fill('Nagisa.E2E@example.com');
    await page.getByRole('radiogroup', { name: 'ロール' }).getByRole('radio', { name: 'リーダー' }).check();
    await email.press('Enter');
    const dialog = page.getByRole('dialog', { name: '招待の URL' });
    await expect(dialog).toBeVisible();
    // 開いた直後は本文にフォーカスを置く（読み上げが URL の値より先に、二度と出せないことの注意まで続けて読める）
    await expect(dialog.locator('p', { hasText: '招待しました。' })).toBeFocused();
    const url = dialog.getByLabel('招待の URL');
    await expect(url).toHaveValue(/\/invite#[A-Za-z0-9_-]{43}$/);
    const firstUrl = await url.inputValue();
    await expect(dialog.locator('.callout.is-info')).toHaveText(
      `次のメールアドレスの Google アカウントでログインするよう伝えてください。 ${E2E_GOOGLE_INVITE_EMAIL}`,
    );
    await expect(dialog.locator('.callout.is-warn')).toHaveText(
      /^この URL はこの画面を閉じると二度と出せません。期限は14日（\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2} まで）です。期限までに本人へ伝えてください。$/,
    );
    await expect(dialog).toContainText(
      '同じメールアドレスで招待し直すと、新しい招待の URL が出ます（期限が切れた後は、冒険者ギルドの人数が上限なら招待し直せません）。招待し直すと（ほかのリーダーが招待し直したときも）、前の招待の URL は使えなくなります。',
    );
    await dialog.getByRole('button', { name: 'コピー' }).click();
    await expect(page.locator('.toasts:visible .toast').last()).toHaveText('招待の URL をコピーしました');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstUrl);

    // 閉じるとメールアドレスの欄へ戻り、読み直した承諾待ちに、手段と期限が出る
    // 下の「閉じる」（右上の × も同じ名前）
    const close = dialog.getByText('閉じる', { exact: true });
    await close.click();
    await expect(dialog).toBeHidden();
    await expectFocusReturned(page, email);
    await expect(email).toHaveValue('');
    await expect(invitations.locator('tbody tr')).toHaveCount(2);
    const row = invitations.locator('tbody tr', { hasText: E2E_GOOGLE_INVITE_EMAIL });
    await expect(row.locator('td').nth(1)).toHaveText(/^Google\s*\d{4}-\d{2}-\d{2} まで$/);
    await expect(row.locator('td').nth(2)).toHaveText('リーダー');

    // 同じアドレスで招待し直すと、新しい URL が出て、前の招待は取り消されて一覧から消える（ロールは一般に戻っている）
    await email.fill(E2E_GOOGLE_INVITE_EMAIL);
    await page.getByRole('button', { name: '招待する' }).click();
    await expect(dialog).toBeVisible();
    await expect(url).toHaveValue(/\/invite#[A-Za-z0-9_-]{43}$/);
    expect(await url.inputValue()).not.toBe(firstUrl);
    await close.click();
    await expectFocusReturned(page, email);
    await expect(invitations.locator('tbody tr')).toHaveCount(2);
    await expect(row).toHaveCount(1);
    await expect(row.locator('td').nth(2)).toHaveText('一般');
    // ブラウザが出すのは、形の合わないアドレスを送った 400 の1件だけ
    expect(await collect()).toEqual([
      'Failed to load resource: the server responded with a status of 400 (Bad Request)',
    ]);
    // コピーのトースト（4 秒）が終わりの画面（evidence-<n>.png）に写るかが、実行の速さで変わるので、消えるのを待つ（#491）
    await expect(page.locator('.toasts:visible .toast')).toHaveCount(0, { timeout: 10_000 });
  });

  test('GitHub のユーザー名を確かめて招待すると承諾待ちに出て、取り消すと消える', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto(HIBARI_MEMBERS_PATH);
    const invitations = page.getByRole('table', { name: '承諾待ちの招待の一覧' });
    await expect(invitations.locator('tbody tr')).toHaveCount(1);
    await expect(invitations.locator('tbody tr').first()).toContainText('kaede--seed');

    await page.route('**/api/hibari/invitee-resolve', (route) =>
      route.fulfill({
        json: {
          login_subject: '9000000000000301',
          login_name: 'nagi--seed',
          display_name: '凪',
          avatar_url: null,
          already_counted: false,
        },
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
        json: { invitation_id: '019a0000-0000-7000-8000-00000000ffff', login_name: 'nagi--seed', invite: null },
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
    // 入力は空に戻り、続けて招待できるようユーザー名の欄へフォーカスが戻る
    await expect(page.getByLabel('GitHub のユーザー名')).toHaveValue('');
    await expect(page.getByLabel('GitHub のユーザー名')).toBeFocused();
    await page.unroute('**/api/hibari/member-list');

    // seed の招待を本物の API で取り消す。読み直した一覧から消える
    await page.getByRole('button', { name: 'kaede--seed への招待を取り消す' }).click();
    await expect(page.locator('.toasts:visible .toast').last()).toHaveText('招待を取り消しました');
    await expect(page.getByText('kaede--seed')).toHaveCount(0);
    await expect(page.getByText('承諾待ちの招待はありません')).toBeVisible();
    // 押したボタンが消えたので、行が残っていない節の見出しへフォーカスを移す
    await expect(page.getByRole('heading', { level: 2, name: '承諾待ちの招待' })).toBeFocused();
    expect(await collect()).toEqual([]);
    // 取り消しのトースト（4 秒）が終わりの画面（evidence-<n>.png）に写るかが、実行の速さで変わるので、消えるのを待つ（#491）
    await expect(page.locator('.toasts:visible .toast')).toHaveCount(0, { timeout: 10_000 });
  });
});
