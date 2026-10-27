// タスクのコメント（詳細の引き出しの「コメント N」のタブ）: 書く → 直す → 消す、書きかけの確認、リーダーが人のコメントを消す、
// 直している途中に消されたら書きかけを残して知らせる、終了したワークスペースでは書く欄と操作を出さない。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者（リーダー）はミナト、一般はハルカ
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

// seed の受託開発チーム（ミナトがリーダー、ハルカが一般）の、ハルカが作った「問い合わせテンプレートを整える」。
// 木を変えないよう、タスクは足さずにコメントだけを足す（本文は実行ごとに変える）
const SEED_TASK_URL = '/aoba/w/019a0000-0000-7000-8000-000000000401?task=019a0000-0000-7000-8000-000000000804';
const SEED_TASK_TITLE = '問い合わせテンプレートを整える';

async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '依頼を出す' }).click();
  const dialog = page.getByRole('dialog', { name: '依頼を出す' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '依頼を出す' }).click();
  await expect(dialog).toBeHidden();
}

async function openDrawer(page: Page, title: string): Promise<Locator> {
  await page.locator('.entry', { hasText: title }).getByRole('link', { name: title }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  return drawer;
}

// 人ごとの画面。seed のセッションの Cookie を置いて開く
async function pageAs(browser: Browser, baseURL: string | undefined, who: 'admin' | 'member'): Promise<Page> {
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  await signIn(context, baseURL, who);
  return context.newPage();
}

// 本文で探したコメントを、ID（data-comment）で指し直す。直している間と消した後は本文の文字が無くなるので、本文では探し続けられない
async function commentOf(drawer: Locator, body: string): Promise<Locator> {
  const found = drawer.locator('.comment', { hasText: body });
  await expect(found).toBeVisible();
  const id = await found.getAttribute('data-comment');
  return drawer.locator(`[data-comment="${id}"]`);
}

async function sendComment(drawer: Locator, body: string): Promise<Locator> {
  await drawer.getByRole('textbox', { name: 'コメントを書く' }).fill(body);
  await drawer.getByRole('button', { name: '送る' }).click();
  return commentOf(drawer, body);
}

test.describe('自分のコメント', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('書くと末尾に足され、件数が増える。直すと「編集済み」が付き、消すと「削除されました」と残る', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await createWorkspace(page, 'コメントのパーティ', 'game');
    await addTask(page, '手順を確かめる');
    const drawer = await openDrawer(page, '手順を確かめる');

    // 初めはコメントのタブ。まだ無い
    const tab = drawer.getByRole('tab', { name: /^コメント/ });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toHaveText('コメント 0');
    const panel = drawer.getByRole('tabpanel', { name: /^コメント/ });
    await expect(panel.getByText('まだコメントはありません。')).toBeVisible();

    // 空のまま送ると、欄の下に理由を出して送らない
    await panel.getByRole('button', { name: '送る' }).click();
    await expect(panel.getByText('コメントを書いてから送ってください')).toBeVisible();

    // Markdown で書いて送る。欄は空になり、末尾に足される
    const input = panel.getByRole('textbox', { name: 'コメントを書く' });
    await input.fill('手順の **2 番目** から進めます');
    await panel.getByRole('button', { name: '送る' }).click();
    const comment = await commentOf(panel, '手順の');
    await expect(comment.locator('strong')).toHaveText('2 番目');
    await expect(comment).toContainText('ミナト');
    await expect(comment.locator('time')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(input).toHaveValue('');
    await expect(tab).toHaveText('コメント 1');

    // 直す。本文がその場で欄に替わり、保存すると「編集済み」が付く
    await comment.getByRole('button', { name: '編集', exact: true }).click();
    const edit = comment.getByRole('textbox', { name: 'コメントを直す' });
    await expect(edit).toBeFocused();
    await expect(edit).toHaveValue('手順の **2 番目** から進めます');
    await edit.fill('手順の **3 番目** から進めます');
    await comment.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'コメントを直しました' })).toBeVisible();
    await expect(comment.locator('strong')).toHaveText('3 番目');
    await expect(comment.locator('.comment-head')).toContainText('編集済み');
    await expect(comment.getByRole('button', { name: '編集', exact: true })).toBeFocused();

    // 消す。確かめてから消し、「削除されました」と残る。件数から外れる
    await comment.getByRole('button', { name: '削除', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'コメントを削除する' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '削除する' }).click();
    await expect(comment.locator('.comment-body')).toHaveText('削除されました');
    await expect(comment.getByRole('button')).toHaveCount(0);
    await expect(tab).toHaveText('コメント 0');
    await expect(comment.locator('strong')).toHaveCount(0);

    // 変更の履歴のタブにはコメントの行を出さない
    await drawer.getByRole('tab', { name: '変更の履歴' }).click();
    const history = drawer.getByRole('tabpanel', { name: '変更の履歴' });
    await expect(history.locator('.history > li')).toHaveCount(1);
    expect(await collect()).toEqual([]);
  });

  test('書きかけのコメントは、タブを切り替えても残り、閉じようとすると捨てるかを確かめる', async ({ page }) => {
    await createWorkspace(page, '書きかけのコメントのパーティ', 'game');
    await addTask(page, '書きかけを残す');
    const drawer = await openDrawer(page, '書きかけを残す');
    const input = drawer.getByRole('textbox', { name: 'コメントを書く' });
    await input.fill('まだ送っていない文');

    // タブを切り替えても消えない（矢印キーでも移れる）
    await drawer.getByRole('tab', { name: '変更の履歴' }).click();
    await expect(input).toBeHidden();
    await drawer.getByRole('tab', { name: '変更の履歴' }).press('ArrowLeft');
    await expect(drawer.getByRole('tab', { name: /^コメント/ })).toBeFocused();
    await expect(input).toHaveValue('まだ送っていない文');

    // 閉じようとすると確かめる。書き続けると残る
    await drawer.getByRole('button', { name: '閉じる' }).click();
    const discard = page.getByRole('dialog', { name: '書きかけを捨てますか' });
    await discard.getByRole('button', { name: '書き続ける' }).click();
    await expect(discard).toBeHidden();
    await expect(input).toHaveValue('まだ送っていない文');

    // 送って空にすると、確かめずに閉じる
    await drawer.getByRole('button', { name: '送る' }).click();
    await expect(input).toHaveValue('');
    await expect(drawer.locator('.comment', { hasText: 'まだ送っていない文' })).toBeVisible();

    // 直している途中も書きかけ。捨てると閉じる
    const comment = await commentOf(drawer, 'まだ送っていない文');
    await comment.getByRole('button', { name: '編集', exact: true }).click();
    await comment.getByRole('textbox', { name: 'コメントを直す' }).fill('直している途中の文');
    await page.keyboard.press('Escape');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: '捨てる' }).click();
    await expect(page.getByRole('dialog', { name: '書きかけを残す' })).toHaveCount(0);
    await expect(page).not.toHaveURL(/\?task=/);
  });

  test('送るのに失敗したら、文を欄に残して理由を出す', async ({ page }) => {
    await createWorkspace(page, '送れないパーティ', 'game');
    await addTask(page, '送れない依頼');
    const drawer = await openDrawer(page, '送れない依頼');
    await page.route('**/api/aoba/comment-create', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    const input = drawer.getByRole('textbox', { name: 'コメントを書く' });
    await input.fill('届かない文');
    await drawer.getByRole('button', { name: '送る' }).click();
    await expect(
      drawer.getByText('コメントを送れませんでした。書いた文は残しています。もう一度試してください。'),
    ).toBeVisible();
    await expect(input).toHaveValue('届かない文');
    await page.unroute('**/api/aoba/comment-create');
    await drawer.getByRole('button', { name: '送る' }).click();
    await expect(drawer.locator('.comment', { hasText: '届かない文' })).toBeVisible();
    await expect(input).toHaveValue('');
  });

  test('終了したワークスペースでは、コメントを読めるが、書く欄と操作を出さない', async ({ page }) => {
    await createWorkspace(page, 'コメントを閉じるパーティ', 'game');
    await addTask(page, '閉じた後に読む');
    let drawer = await openDrawer(page, '閉じた後に読む');
    await sendComment(drawer, '閉じる前に書いた文');
    await drawer.getByRole('button', { name: '閉じる' }).click();
    await expect(drawer).toBeHidden();

    // ワークスペースの情報だけを閉じた状態に差し替える
    await page.route('**/api/aoba/workspace', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, closed_at: '2026-10-20T00:00:00.000Z' } });
    });
    await page.reload();
    drawer = await openDrawer(page, '閉じた後に読む');
    const comment = drawer.locator('.comment', { hasText: '閉じる前に書いた文' });
    await expect(comment).toBeVisible();
    await expect(comment.getByRole('button')).toHaveCount(0);
    await expect(drawer.getByRole('textbox', { name: 'コメントを書く' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '送る' })).toHaveCount(0);
  });
});

test('リーダーは人のコメントを消せるが直せず、直している途中に消されたら書きかけを残して知らせる', async ({
  browser,
  baseURL,
}) => {
  const body = `テンプレートの件、確認お願いします ${Date.now()}`;
  const member = await pageAs(browser, baseURL, 'member');
  const leader = await pageAs(browser, baseURL, 'admin');
  try {
    // ハルカが書いて、直し始める
    await member.goto(SEED_TASK_URL);
    const memberDrawer = member.getByRole('dialog', { name: SEED_TASK_TITLE });
    const mine = await sendComment(memberDrawer, body);
    const commentId = await mine.getAttribute('data-comment');
    await mine.getByRole('button', { name: '編集', exact: true }).click();
    await mine.getByRole('textbox', { name: 'コメントを直す' }).fill(`${body}（直しかけ）`);

    // リーダーのミナトには「削除」だけが出る。消すと「削除されました」と残る
    await leader.goto(SEED_TASK_URL);
    const leaderDrawer = leader.getByRole('dialog', { name: SEED_TASK_TITLE });
    const theirs = leaderDrawer.locator(`[data-comment="${commentId}"]`);
    await expect(theirs).toContainText(body);
    await expect(theirs.getByRole('button', { name: '編集', exact: true })).toHaveCount(0);
    await theirs.getByRole('button', { name: '削除', exact: true }).click();
    await leader.getByRole('dialog', { name: 'コメントを削除する' }).getByRole('button', { name: '削除する' }).click();
    await expect(theirs.locator('.comment-body')).toHaveText('ミナトが削除しました');
    await expect(leaderDrawer.getByText(body)).toHaveCount(0);

    // ハルカが保存すると断られ、書きかけを欄に残したまま知らせる
    await mine.getByRole('button', { name: '保存', exact: true }).click();
    await expect(mine.getByText('このコメントは削除されました。書きかけの文は欄に残しています。')).toBeVisible();
    await expect(mine.getByRole('textbox', { name: 'コメントを直す' })).toHaveValue(`${body}（直しかけ）`);
    await expect(mine.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
    // 取り消すと、消した人の名前を添えて残る
    await mine.getByRole('button', { name: '取り消し', exact: true }).click();
    await expect(mine.locator('.comment-body')).toHaveText('ミナトが削除しました');
  } finally {
    await member.context().close();
    await leader.context().close();
  }
});

test('一般のメンバーには、人のコメントの「編集」と「削除」を出さない', async ({ browser, baseURL }) => {
  const body = `ミナトのコメント ${Date.now()}`;
  const leader = await pageAs(browser, baseURL, 'admin');
  const member = await pageAs(browser, baseURL, 'member');
  try {
    await leader.goto(SEED_TASK_URL);
    await sendComment(leader.getByRole('dialog', { name: SEED_TASK_TITLE }), body);
    await member.goto(SEED_TASK_URL);
    const comment = member.getByRole('dialog', { name: SEED_TASK_TITLE }).locator('.comment', { hasText: body });
    await expect(comment).toBeVisible();
    await expect(comment.getByRole('button')).toHaveCount(0);
  } finally {
    await leader.context().close();
    await member.context().close();
  }
});
