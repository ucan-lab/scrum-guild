// エピックとストーリーの削除: ダイアログの下の「この<エピック>を削除する」から、配下の件数と配下の扱い（残す、まとめて削除する）を
// 選ぶ確認を開き、削除したら木を読み直す。削除できない人には削除のボタンを出さない。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  createWorkspace,
  expectFocusReturned,
  signIn,
  waitForResponses,
  waitForSettled,
  watchViolations,
} from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

// 題の行を自分の直下に持つ木の1件（エピックの中のストーリーで、エピックの方を拾わない）
function rowGroup(page: Page, title: string) {
  return page.locator(
    `xpath=//div[contains(@class, "tree-group")][./div[contains(@class, "tree-row")]//*[contains(@class, "tree-link") and normalize-space() = "${title}"]]`,
  );
}

// 作った後は、木の読み直しが返るまで待つ。読み直しで木が替わると、画面は画面だけで足したタスクと並べ替えを捨てる（+page.svelte）。
// 返る前に次のタスクを足すか並べ替えると、それが遅れて届いた読み直しで消えうる
async function create(page: Page, label: string, title: string): Promise<void> {
  await page.getByRole('button', { name: label }).click();
  const dialog = page.getByRole('dialog', { name: label });
  await dialog.getByLabel('タイトル').fill(title);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
}

async function addTask(page: Page, storyTitle: string, title: string, createLabel: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`を足す: ${storyTitle}$`) }).click();
  const dialog = page.getByRole('dialog', { name: createLabel });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: createLabel }).click();
  await expect(dialog).toBeHidden();
}

test('スクラムの言葉: エピックを配下を残して削除し、残ったストーリーを配下ごと削除する', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '削除のワークスペース');

  await create(page, 'エピックを作る', '会員証を作り直す');
  await create(page, 'ストーリーを作る', 'カードの画面');
  await page.getByRole('button', { name: '親を移す: カードの画面' }).click();
  const moveDialog = page.getByRole('dialog', { name: '「カードの画面」の親を移す' });
  // 親の移動は画面を先に変えてから送る。削除の確認が配下を数える前に、移動の応答を待つ（#363）
  const moved = waitForResponses(page, '/story-move');
  await moveDialog.getByRole('button', { name: '移す' }).click();
  await expect(moveDialog).toBeHidden();
  await expect(
    rowGroup(page, '会員証を作り直す').locator('.tree-children .tree-row.is-story button.tree-link'),
  ).toHaveText(['カードの画面']);
  await addTask(page, 'カードの画面', 'バーコードを出す', '起票');
  await moved;

  // 作るときのダイアログには削除のボタンを出さない
  await page.getByRole('button', { name: 'エピックを作る' }).click();
  const createDialog = page.getByRole('dialog', { name: 'エピックを作る' });
  await expect(createDialog.getByRole('button', { name: 'このエピックを削除する' })).toHaveCount(0);
  await createDialog.getByRole('button', { name: 'やめる' }).click();
  await expect(createDialog).toBeHidden();

  // 題からエピックの画面を開き、見出しの横の「直す」で開くダイアログの下の削除から、確認を開く。配下の件数と、既定の「残す」が出る
  await page.getByRole('link', { name: '会員証を作り直す', exact: true }).click();
  await page.getByRole('button', { name: 'エピックを直す' }).click();
  const epicDialog = page.getByRole('dialog', { name: 'エピック', exact: true });
  await expect(epicDialog.getByLabel('タイトル')).toHaveValue('会員証を作り直す');
  const deleteEpic = epicDialog.getByRole('button', { name: 'このエピックを削除する' });
  await deleteEpic.click();
  const confirm = page.getByRole('dialog', { name: 'エピックを削除する' });
  await expect(confirm.getByText('「会員証を作り直す」を削除します。')).toBeVisible();
  const keep = confirm.getByRole('radio', { name: /配下を親なしで残す/ });
  await expect(keep).toBeChecked();
  await expect(keep).toBeFocused();
  // 言葉と数、数と「件」の間は改行させない空白（U+00A0）
  await expect(
    confirm.getByText(
      'ストーリー 1 件は親なしのストーリーとして末尾へ移り、その下のタスク 1 件はストーリーの下のままです。区分はエピックの区分を写します。',
    ),
  ).toBeVisible();
  await expect(confirm.getByText('ストーリー 1 件とタスク 1 件を削除します')).toBeVisible();

  // やめると、削除のボタンへ戻る
  await confirm.getByRole('button', { name: 'やめる' }).click();
  await expect(confirm).toBeHidden();
  await expectFocusReturned(page, deleteEpic);

  await deleteEpic.click();
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(confirm).toBeHidden();
  await expect(epicDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'エピックを削除しました' })).toBeVisible();
  // 削除したら、バックログへ戻る
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  await expect(page.getByRole('link', { name: '会員証を作り直す', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeFocused();
  // ストーリーは親なしになり、その下のタスクはストーリーの下のまま
  const story = rowGroup(page, 'カードの画面');
  await expect(story.locator('.tree-row.is-story')).toHaveClass(/is-root/);
  await expect(story.locator('.entry', { hasText: 'バーコードを出す' })).toHaveCount(1);

  // ストーリーを配下ごと削除する
  await page.getByRole('button', { name: 'カードの画面', exact: true }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリー', exact: true });
  await storyDialog.getByRole('button', { name: 'このストーリーを削除する' }).click();
  const storyConfirm = page.getByRole('dialog', { name: 'ストーリーを削除する' });
  await expect(
    storyConfirm.getByText('タスク 1 件を削除します。取り込んだタスクは削除せず、アーカイブへ移します'),
  ).toBeVisible();
  await storyConfirm.getByRole('radio', { name: /配下もまとめて削除する/ }).check();
  await storyConfirm.getByRole('button', { name: '削除する' }).click();
  await expect(storyDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーを削除しました' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'カードの画面', exact: true })).toHaveCount(0);
  await expect(page.locator('.entry', { hasText: 'バーコードを出す' })).toHaveCount(0);

  // 読み直しても同じ
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(page.locator('.tree-link')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('作ったワークスペース: 配下の無いエピックは選ばせずに削除する。断られたら理由を確認の中に出す', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '削除のワークスペース');
  await create(page, 'エピックを作る', '倉庫の棚卸し');
  await page.waitForLoadState('networkidle');

  await page.getByRole('link', { name: '倉庫の棚卸し', exact: true }).click();
  await page.getByRole('button', { name: 'エピックを直す' }).click();
  const epicDialog = page.getByRole('dialog', { name: 'エピック', exact: true });
  await epicDialog.getByRole('button', { name: 'このエピックを削除する' }).click();
  const confirm = page.getByRole('dialog', { name: 'エピックを削除する' });
  await expect(confirm.getByText('配下のストーリーはありません。')).toBeVisible();
  await expect(confirm.getByRole('radio')).toHaveCount(0);

  // 権限が無い（別の画面で外された）と断られたら、確認を開いたまま理由を出す
  await page.route('**/epic-delete', (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'forbidden' } } }),
  );
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(confirm.getByRole('alert')).toHaveText('作った人とリーダーだけが削除できます');
  await page.unroute('**/epic-delete');

  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(epicDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'エピックを削除しました' })).toBeVisible();
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  await expect(page.getByRole('link', { name: '倉庫の棚卸し', exact: true })).toHaveCount(0);
});

test('確認は開いたときに件数とまとめて削除できるかを読み直し、読んでいる間は削除を押せない。まとめて削除できなければ選択肢を押せなくし、理由を出す', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '読み直しのワークスペース');
  await create(page, 'ストーリーを作る', '問い合わせの窓口');
  await addTask(page, '問い合わせの窓口', '返信の型を作る', '起票');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: '問い合わせの窓口', exact: true }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリー', exact: true });
  await expect(storyDialog.getByLabel('タイトル')).toHaveValue('問い合わせの窓口');

  // ダイアログを開いた後に、別の画面で他の人のタスクが2件足された形にする（確認を開いたときの読み直しの応答を書き換える）。
  // 応答を待たせて、読んでいる間は削除を押せないことも確かめる
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/story-get', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await held;
    await route.fulfill({ response, json: { ...body, can_delete_children: false, children: { tasks: 3 } } });
  });
  await storyDialog.getByRole('button', { name: 'このストーリーを削除する' }).click();
  const confirm = page.getByRole('dialog', { name: 'ストーリーを削除する' });
  const submit = confirm.getByRole('button', { name: '削除する' });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  const choices = confirm.getByRole('radiogroup');
  await expect(choices.getByText('タスク 1 件は親なしのタスク')).toBeVisible();
  release();
  // 件数が変わったことは、読み上げの領域にも出す
  await expect(confirm.getByRole('status').filter({ hasText: /タスク\s3\s件は親なしのタスク/ })).toHaveCount(1);
  await expect(choices.getByText('タスク 3 件は親なしのタスク')).toBeVisible();
  await expect(submit).toHaveAttribute('aria-disabled', 'false');
  const all = confirm.getByRole('radio', { name: /配下もまとめて削除する/ });
  await expect(all).toBeDisabled();
  await expect(all).toHaveAccessibleDescription(
    '配下に他の人が作ったものがあるため、まとめて削除できるのはリーダーだけです。',
  );
  await expect(confirm.getByRole('radio', { name: /配下を親なしで残す/ })).toBeChecked();
  await page.unroute('**/story-get');

  // 残す削除はできる
  await submit.click();
  await expect(storyDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーを削除しました' })).toBeVisible();
  await expect(page.locator('.entry', { hasText: '返信の型を作る' })).toHaveCount(1);
});

test('確認を開いた後の読み直しで配下が無くなったら、選択肢を消してやめるボタンへフォーカスを移し、変わった中身を読み上げの領域に出す', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '配下が消えるワークスペース');
  await create(page, 'ストーリーを作る', '請求書の発行');
  await addTask(page, '請求書の発行', '宛名を直す', '起票');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: '請求書の発行', exact: true }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリー', exact: true });
  await expect(storyDialog.getByLabel('タイトル')).toHaveValue('請求書の発行');

  // 別の画面で配下のタスクが外された形にする。応答を待たせて、選択肢にフォーカスが置かれてから差し替える
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/story-get', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await held;
    await route.fulfill({ response, json: { ...body, children: { tasks: 0 } } });
  });
  await storyDialog.getByRole('button', { name: 'このストーリーを削除する' }).click();
  const confirm = page.getByRole('dialog', { name: 'ストーリーを削除する' });
  await expect(confirm.getByRole('radio', { name: /配下を親なしで残す/ })).toBeFocused();
  release();
  await expect(confirm.getByRole('radio')).toHaveCount(0);
  await expect(confirm.getByRole('button', { name: 'やめる' })).toBeFocused();
  await expect(confirm.getByRole('status').filter({ hasText: '配下のタスクはありません。' })).toHaveCount(1);
  await page.unroute('**/story-get');
});

test('読み直しで削除できなくなったら主ボタンを押せなくし、閉じた後に届いた 404 では元のダイアログを閉じない', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '権限が変わるワークスペース');
  await create(page, 'ストーリーを作る', '在庫の通知');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: '在庫の通知', exact: true }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリー', exact: true });
  await expect(storyDialog.getByLabel('タイトル')).toHaveValue('在庫の通知');
  const deleteStory = storyDialog.getByRole('button', { name: 'このストーリーを削除する' });
  const confirm = page.getByRole('dialog', { name: 'ストーリーを削除する' });

  // 別の画面でリーダーから外された形にする。主ボタンは押せず、押しても送らない
  let deletes = 0;
  await page.route('**/story-delete', async (route) => {
    deletes++;
    await route.continue();
  });
  await page.route('**/story-get', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, can_delete: false } });
  });
  await deleteStory.click();
  const submit = confirm.getByRole('button', { name: '削除する' });
  await expect(confirm.getByRole('alert')).toHaveText('作った人とリーダーだけが削除できます');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.click({ force: true });
  await expect(confirm).toBeVisible();
  expect(deletes).toBe(0);
  await confirm.getByRole('button', { name: 'やめる' }).click();
  await expect(confirm).toBeHidden();
  await page.unroute('**/story-get');

  // 読み直しの応答が届く前に確認を閉じ、その後に 404 が届いても、元のダイアログは開いたまま
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let answered: () => void = () => {};
  const done = new Promise<void>((resolve) => (answered = resolve));
  await page.route('**/story-get', async (route) => {
    await held;
    await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not found' } } });
    answered();
  });
  await deleteStory.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'やめる' }).click();
  await expect(confirm).toBeHidden();
  release();
  await done;
  await page.waitForLoadState('networkidle');
  await expect(storyDialog).toBeVisible();
  await expectFocusReturned(page, deleteStory);
  await page.unroute('**/story-get');
  await page.unroute('**/story-delete');
});

// seed のワークスペース（受託開発チーム）。エピック「ポイントの交換先を増やす」とストーリーは、管理者のミナトが作った
const SEED_CLIENT_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test('作った人でもリーダーでもないメンバーには、削除のボタンを出さず、削除できる人を出す', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'member');
  await page.goto(SEED_CLIENT_WORKSPACE);
  const epic = page.getByRole('link', { name: 'ポイントの交換先を増やす', exact: true });
  await expect(epic).toBeVisible();
  await waitForSettled(page);
  await epic.click();
  await page.getByRole('button', { name: 'エピックを直す' }).click();
  const epicDialog = page.getByRole('dialog', { name: 'エピック', exact: true });
  await expect(epicDialog.getByLabel('タイトル')).toHaveValue('ポイントの交換先を増やす');
  await expect(epicDialog.getByRole('button', { name: /を削除する/ })).toHaveCount(0);
  await expect(epicDialog.getByText('削除できるのは作った人とリーダーです。')).toBeVisible();
  await epicDialog.getByRole('button', { name: 'やめる' }).click();
  await page.getByRole('link', { name: 'バックログへ戻る' }).click();

  await page.getByRole('button', { name: '送料の割引にポイントを使える', exact: true }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリー', exact: true });
  await expect(storyDialog.getByLabel('タイトル')).toHaveValue('送料の割引にポイントを使える');
  await expect(storyDialog.getByRole('button', { name: /を削除する/ })).toHaveCount(0);
  await expect(storyDialog.getByText('削除できるのは作った人とリーダーです。')).toBeVisible();
});
