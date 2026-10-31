// 今日やること。区分の出し分けと並び、持ち越しと「期日は今日」の注記、閉じた区分の開閉、スプリントゴール、空の状態、読み込みの失敗を確かめる。
// 画面が決める出し分けと並びを確かめるので、`today` の応答をテストの中で組む。応答の行は自分の今日（today）と週の始まりを持つため、
// 実行する日にも seed の日付にも依存しない。サーバーが返す行の範囲は test/today.test.ts が確かめる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。一般のユーザーはハルカ（あおば開発の受託開発チームに所属）
import type { Locator, Page } from '@playwright/test';
import { experienceSummary } from '../src/shared/operations/experience/index.ts';
import { today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { failOperation, mockOperation } from './operations.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'member');
});

// 応答の行が持つ「今日」。2026-11-04 は水曜で、週の始まりが月曜なら今週は 11-02 から 11-08 まで
const TODAY = '2026-11-04';
const WORKSPACE_A = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };
const WORKSPACE_B = { id: '019a0000-0000-7000-8000-0000000004ff', name: 'ひばり班' };

function row(id: string, overrides: Partial<TodayTask> = {}): TodayTask {
  return {
    id,
    title: id,
    points: null,
    due_on: null,
    today_on: null,
    completed_at: null,
    workspace_id: WORKSPACE_A.id,
    workspace_name: WORKSPACE_A.name,
    today: TODAY,
    week_start: 1,
    position: 'a0',
    carry_days: 0,
    sprint_active: false,
    is_today_completed: false,
    assignee: null,
    repository: null,
    sprint: null,
    ...overrides,
  };
}

const ALL_SECTIONS = [
  row('期日切れの遅い方', { due_on: '2026-11-02' }),
  row('期日切れの早い方', { due_on: '2026-11-01', workspace_id: WORKSPACE_B.id, workspace_name: WORKSPACE_B.name }),
  row('今日付けた印', { today_on: TODAY, due_on: '2026-11-04' }),
  row('三日前に付けた印', { today_on: '2026-11-01', carry_days: 3, due_on: '2026-11-20' }),
  row('今日が期日', { due_on: TODAY, workspace_id: WORKSPACE_B.id, workspace_name: WORKSPACE_B.name }),
  row('金曜が期日', { due_on: '2026-11-06' }),
  row('スプリントだけ', {
    sprint_active: true,
    sprint: { id: 'sprint-1', name: '第3スプリント', start_on: '2026-11-02', end_on: '2026-11-15' },
  }),
  row('今日完了した', { completed_at: '2026-11-04T01:00:00.000Z', is_today_completed: true, due_on: '2026-11-04' }),
];

function region(page: Page, name: string): Locator {
  return page.getByRole('region', { name, exact: true });
}

// 区分の見出し。右の列の面（LevelPanel）の見出しは含めない
function sectionHeadings(page: Page): Locator {
  return page.locator('.layout-main').getByRole('heading', { level: 2 });
}

function tally(page: Page, label: string): Locator {
  return page
    .locator('.tally > div')
    .filter({ has: page.locator('dt', { hasText: label }) })
    .locator('dd');
}

test('区分は期日切れ、今日やると決めたもの、今週が期日、進行中のスプリント、今日の完了の順に並び、見出しの横に件数が出る', async ({
  page,
}) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: ALL_SECTIONS, sprint_goals: [] });
  await page.goto('/aoba');

  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  await expect(sectionHeadings(page)).toHaveText([
    '期日切れ',
    '今日やると決めたもの',
    '今週が期日',
    '進行中のスプリント',
    '今日の完了',
  ]);
  await expect(tally(page, '今日やると決めたもの')).toHaveText('2');
  await expect(tally(page, '期日切れ')).toHaveText('2');
  await expect(tally(page, '今週が期日')).toHaveText('2');
  await expect(tally(page, '今日の完了')).toHaveText('1');
  // 見出しの横の件数は、区分に出る件数と同じ
  await expect(region(page, '期日切れ').locator('.section-count')).toHaveText('2 件');
  await expect(region(page, '今週が期日').locator('.section-count')).toHaveText('2 件');
});

test('区分の中は期日の早い順で、今日やると決めたものは持ち越しが先頭。完了の操作は出ない', async ({ page }) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: ALL_SECTIONS, sprint_goals: [] });
  await page.goto('/aoba');

  const titles = (name: string) => region(page, name).locator('.entry-title');
  await expect(titles('期日切れ')).toHaveText(['期日切れの早い方', '期日切れの遅い方']);
  await expect(titles('今日やると決めたもの')).toHaveText(['三日前に付けた印', '今日付けた印']);
  await expect(titles('今週が期日')).toHaveText(['今日が期日', '金曜が期日']);
  await expect(titles('今日の完了')).toHaveText(['今日完了した']);
  // 印と完了の操作は 3 本目で足す。押しても何も起きないボタンを置かない
  await expect(page.getByRole('button', { name: /完了にする/ })).toHaveCount(0);
});

test('行にワークスペース名の印が出る。持ち越しは日数の注記、今日が期日の行は「期日は今日」の印を添える', async ({
  page,
}) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: ALL_SECTIONS, sprint_goals: [] });
  await page.goto('/aoba');

  const entry = (title: string) => page.locator('.entry', { hasText: title });
  await expect(entry('期日切れの早い方').locator('.entry-meta .tag')).toHaveText('ひばり班');
  await expect(entry('金曜が期日').locator('.entry-meta .tag')).toHaveText('受託開発チーム');
  // 行のメタ情報は 1 つ
  await expect(entry('金曜が期日').locator('.entry-meta')).toHaveCount(1);

  await expect(entry('三日前に付けた印').locator('.entry-meta .props-note')).toHaveText('3日前に印を付けた');
  await expect(entry('今日付けた印').locator('.props-note')).toHaveCount(0);

  await expect(entry('今日が期日').locator('.entry-meta .chip.is-warn')).toHaveText('期日は今日');
  await expect(entry('金曜が期日').locator('.entry-meta .chip')).toHaveCount(0);
  // 今日やると決めたものの区分では、期日が今日でも「期日は今日」を添えない
  await expect(entry('今日付けた印').locator('.entry-meta .chip')).toHaveCount(0);
});

test('進行中のスプリントの区分は閉じて件数だけが出て、見出しの行を押すと一覧が開く', async ({ page }) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: ALL_SECTIONS, sprint_goals: [] });
  await page.goto('/aoba');

  const sprint = page.locator('details.section', { hasText: '進行中のスプリント' });
  await expect(sprint.locator('.section-count')).toHaveText('1 件');
  await expect(sprint).not.toHaveAttribute('open', '');
  await expect(sprint.getByRole('link', { name: 'スプリントだけ' })).toBeHidden();

  await sprint.locator('summary').click();
  await expect(sprint).toHaveAttribute('open', '');
  await expect(sprint.getByRole('link', { name: 'スプリントだけ' })).toBeVisible();
});

test('スプリントゴールの貼り紙は区分の上に、ワークスペース名とともに、複数行のまま出る', async ({ page }) => {
  const goal = '請求の画面を出す\n画面の確認まで終える';
  await mockOperation(
    page,
    today,
    { slug: 'aoba' },
    {
      tasks: ALL_SECTIONS,
      sprint_goals: [{ workspace_id: WORKSPACE_A.id, workspace_name: WORKSPACE_A.name, goal }],
    },
  );
  await page.goto('/aoba');

  const notice = page.locator('.notice');
  await expect(notice).toHaveCount(1);
  await expect(notice.locator('.notice-label')).toHaveText('スプリントゴール');
  await expect(notice.locator('.notice-title.is-goal')).toHaveText(goal);
  await expect(notice.locator('.notice-title.is-goal')).toHaveCSS('white-space', 'pre-line');
  await expect(notice.locator('.notice-meta')).toHaveText('受託開発チーム');
  // 貼り紙は期日切れの区分より上
  const noticeBox = await notice.boundingBox();
  const overdueBox = await region(page, '期日切れ').boundingBox();
  expect(noticeBox!.y).toBeLessThan(overdueBox!.y);
});

test('長いワークスペース名は行の中で折り返し、全文が読めて横にはみ出さない', async ({ page }) => {
  const name = 'とても長いワークスペースの名前'.repeat(6);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOperation(
    page,
    today,
    { slug: 'aoba' },
    {
      tasks: [row('長い名前の行', { today_on: TODAY, workspace_name: name })],
      sprint_goals: [{ workspace_id: WORKSPACE_A.id, workspace_name: name, goal: '長い名前でも読める' }],
    },
  );
  await page.goto('/aoba');

  await expect(page.locator('.entry-meta .tag')).toHaveText(name);
  await expect(page.locator('.notice-meta')).toHaveText(name);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
});

test('担当のタスクが無いときは今日やると決めたものだけが空で出て、バックログを開くボタンが最初のワークスペースへ移る', async ({
  page,
}) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: [], sprint_goals: [] });
  await page.goto('/aoba');

  await expect(sectionHeadings(page)).toHaveText(['今日やると決めたもの']);
  const section = region(page, '今日やると決めたもの');
  await expect(section.locator('.section-count')).toHaveText('0 件');
  await expect(section.getByText('今日やるタスクはまだありません')).toBeVisible();
  await expect(section.locator('.empty')).not.toContainText('太陽');
  await expect(tally(page, '今日やると決めたもの')).toHaveText('0');

  const open = section.getByRole('link', { name: 'バックログを開く' });
  await expect(open).toHaveAttribute('href', /^\/aoba\/w\/[0-9a-f-]+$/);
  await open.click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
});

test('右の列は「自分の記録」で、経験値を読めなかったときは列ごと出さない', async ({ page }) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: ALL_SECTIONS, sprint_goals: [] });
  await page.goto('/aoba');
  await expect(page.getByRole('complementary', { name: '自分の記録' })).toBeVisible();

  const unroute = await failOperation(page, experienceSummary, { slug: 'aoba' }, 500, 'internal');
  await page.reload();
  await expect(region(page, '期日切れ')).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await unroute();
});

test('今日やることを読めなかったときは、空の一覧にせず読み込みの失敗と「もう一度試す」を出す', async ({ page }) => {
  const unroute = await failOperation(page, today, { slug: 'aoba' }, 500, 'internal');
  await page.goto('/aoba');

  await expect(page.getByRole('heading', { level: 1, name: '読み込めませんでした' })).toBeVisible();
  await expect(page.getByText('今日やるタスクはまだありません')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: '今日やると決めたもの' })).toHaveCount(0);

  await unroute();
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: [], sprint_goals: [] });
  await page.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();
  await expect(page.getByText('今日やるタスクはまだありません')).toBeVisible();
});
