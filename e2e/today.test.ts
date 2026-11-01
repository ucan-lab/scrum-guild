// 今日やること。区分の出し分けと並び、持ち越しと「期日は今日」の注記、閉じた区分の開閉、スプリントゴール、空の状態、読み込みの失敗を確かめる。
// 画面が決める出し分けと並びを確かめるので、`today` の応答をテストの中で組む。応答の行は自分の今日（today）と週の始まりを持つため、
// 実行する日にも seed の日付にも依存しない。サーバーが返す行の範囲は test/today.test.ts が確かめる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。一般のユーザーはハルカ（あおば開発の受託開発チームに所属）
import type { Locator, Page } from '@playwright/test';
import { experienceSummary } from '../src/shared/operations/experience/index.ts';
import { today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { taskComplete, taskReopen, taskTodayMark } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

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
    reopenable: false,
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

test('区分の中は期日の早い順で、今日やると決めたものは持ち越しが先頭。印と完了の操作は未完了の行にだけ出る', async ({
  page,
}) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: ALL_SECTIONS, sprint_goals: [] });
  await page.goto('/aoba');

  const titles = (name: string) => region(page, name).locator('.entry-title');
  await expect(titles('期日切れ')).toHaveText(['期日切れの早い方', '期日切れの遅い方']);
  await expect(titles('今日やると決めたもの')).toHaveText(['三日前に付けた印', '今日付けた印']);
  await expect(titles('今週が期日')).toHaveText(['今日が期日', '金曜が期日']);
  await expect(titles('今日の完了')).toHaveText(['今日完了した']);
  // 未完了の 7 行に、太陽（印）と完了のボタンが出る。印が付いた行だけ押された状態
  await expect(page.locator('.entry .sun')).toHaveCount(7);
  await expect(page.locator('.entry .sun[aria-pressed="true"]')).toHaveCount(2);
  // 進行中のスプリントの区分は閉じていて、中のボタンは役割では数えられないので、太陽と同じく CSS で数える
  await expect(page.locator('.entry .done-btn')).toHaveCount(7);
  // 今日完了した行は、戻せると答えられたときだけ「戻す」を出す（この行は戻せない）
  const done = region(page, '今日の完了').locator('.entry', { hasText: '今日完了した' });
  await expect(done.locator('.sun')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /を戻す: / })).toHaveCount(0);
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

test('今日完了した行は静止した完了の印を持ち、判を押す動き（.is-new）は付かない', async ({ page }) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: ALL_SECTIONS, sprint_goals: [] });
  await page.goto('/aoba');

  const done = region(page, '今日の完了').locator('.entry', { hasText: '今日完了した' });
  await expect(done.locator('.hanko')).toHaveCount(1);
  await expect(done.locator('.hanko')).not.toHaveClass(/\bis-new\b/);
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
  await expect(page.getByRole('complementary', { name: '自分の記録' })).toHaveCount(0);
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

// 読み取りの行を外す。見つからないときは何も外さない（findIndex の -1 を splice に渡すと最後の行が消える）
function removeTask(tasks: TodayTask[], id: unknown): void {
  const index = tasks.findIndex((entry) => entry.id === id);
  if (index >= 0) tasks.splice(index, 1);
}

// 印、完了、戻すの操作。今日の読み取りと、3 つの操作を、行の状態を持つ応答に差し替える（操作の後の読み直しで、行が区分を移る）
async function routeTodayState(page: Page, tasks: TodayTask[]) {
  const calls: { operation: string; input: unknown }[] = [];
  await routeOperation(page, today, { slug: 'aoba' }, (call) => call.fulfill({ tasks, sprint_goals: [] }));
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, (call) => {
    calls.push({ operation: 'task-today-mark', input: call.input });
    const task = tasks.find((entry) => entry.id === call.input.task_id)!;
    task.today_on = call.input.marked ? task.today : null;
    task.carry_days = 0;
    return call.fulfill({ task_id: task.id, today_on: task.today_on });
  });
  await routeOperation(page, taskComplete, { slug: 'aoba' }, (call) => {
    calls.push({ operation: 'task-complete', input: call.input });
    const task = tasks.find((entry) => entry.id === call.input.task_id)!;
    task.completed_at = '2026-11-04T03:00:00.000Z';
    task.is_today_completed = true;
    task.reopenable = true;
    return call.fulfill({ task_id: task.id, completed_at: task.completed_at, left_sprint: false });
  });
  await routeOperation(page, taskReopen, { slug: 'aoba' }, (call) => {
    calls.push({ operation: 'task-reopen', input: call.input });
    const task = tasks.find((entry) => entry.id === call.input.task_id)!;
    task.completed_at = null;
    task.is_today_completed = false;
    task.reopenable = false;
    return call.fulfill({ task_id: task.id, sprint_id: null, column_id: null });
  });
  return calls;
}

test('太陽のボタンで印を付けると今日やると決めたものに移って押された状態になり、もう一度押すと外れて元の区分に戻る', async ({
  page,
}) => {
  const task = row('あとでやる', { due_on: '2026-11-06' });
  const calls = await routeTodayState(page, [task]);
  await page.goto('/aoba');

  const sun = page.getByRole('button', { name: '今日やる: あとでやる' });
  await expect(region(page, '今週が期日').locator('.entry-title')).toHaveText(['あとでやる']);
  await expect(sun).toHaveAttribute('aria-pressed', 'false');

  await sun.click();
  await expect(region(page, '今日やると決めたもの').locator('.entry-title')).toHaveText(['あとでやる']);
  await expect(region(page, '今週が期日')).toHaveCount(0);
  await expect(sun).toHaveAttribute('aria-pressed', 'true');
  await expect(sun).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: '今日やると決めました' })).toBeVisible();

  await sun.click();
  await expect(region(page, '今週が期日').locator('.entry-title')).toHaveText(['あとでやる']);
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  expect(calls.map((call) => call.input)).toEqual([
    { workspace_id: WORKSPACE_A.id, task_id: 'あとでやる', marked: true },
    { workspace_id: WORKSPACE_A.id, task_id: 'あとでやる', marked: false },
  ]);
});

test('完了にすると今日の完了に移って静止でなく判を押す動き付きの印が出て、「戻す」で元の区分に戻る', async ({
  page,
}) => {
  const task = row('終わらせる', { today_on: TODAY });
  const calls = await routeTodayState(page, [task]);
  await page.goto('/aoba');

  await page.getByRole('button', { name: '完了にする: 終わらせる' }).click();
  const done = region(page, '今日の完了').locator('.entry', { hasText: '終わらせる' });
  await expect(done).toBeVisible();
  await expect(done.locator('.hanko')).toHaveClass(/\bis-new\b/);
  await expect(done.locator('.hanko')).toBeFocused();
  await expect(done.locator('.sun')).toHaveCount(0);
  await expect(region(page, '今日やると決めたもの').locator('.entry')).toHaveCount(0);

  await done.getByRole('button', { name: '完了を戻す: 終わらせる' }).click();
  await expect(region(page, '今日やると決めたもの').locator('.entry-title')).toHaveText(['終わらせる']);
  await expect(region(page, '今日の完了')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '完了にする: 終わらせる' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'の完了を戻しました' })).toBeVisible();
  expect(calls.map((call) => call.operation)).toEqual(['task-complete', 'task-reopen']);
});

test('終了したスプリントの中で完了した行には「戻す」を出さない', async ({ page }) => {
  await mockOperation(
    page,
    today,
    { slug: 'aoba' },
    {
      tasks: [
        row('戻せる', { completed_at: '2026-11-04T01:00:00.000Z', is_today_completed: true, reopenable: true }),
        row('終了したスプリント', {
          completed_at: '2026-11-04T01:00:00.000Z',
          is_today_completed: true,
          reopenable: false,
        }),
      ],
      sprint_goals: [],
    },
  );
  await page.goto('/aoba');

  await expect(page.getByRole('button', { name: '完了を戻す: 戻せる' })).toBeVisible();
  await expect(page.getByRole('button', { name: /完了を戻す: 終了したスプリント/ })).toHaveCount(0);
});

test('印を断られたら理由を知らせて読み直し、完了を戻せなかったら理由を知らせて今日の完了に残す', async ({ page }) => {
  const marking = row('ほかの人に替わった', { due_on: '2026-11-06' });
  const finished = row('親が完了した', {
    completed_at: '2026-11-04T01:00:00.000Z',
    is_today_completed: true,
    reopenable: true,
  });
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: [marking, finished], sprint_goals: [] });
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, (call) =>
    call.fail(409, 'conflict', { details: { reason: 'not_assignee' } }),
  );
  await routeOperation(page, taskReopen, { slug: 'aoba' }, (call) =>
    call.fail(409, 'conflict', { details: { reason: 'parent_completed' } }),
  );
  await page.goto('/aoba');

  await page.getByRole('button', { name: '今日やる: ほかの人に替わった' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '担当が替わったため、今日やるの印を付け外しできませんでした' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '今日やる: ほかの人に替わった' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await page.getByRole('button', { name: '完了を戻す: 親が完了した' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'の下のタスクは戻せません' })).toBeVisible();
  await expect(region(page, '今日の完了').locator('.entry-title')).toHaveText(['親が完了した']);
});

test('行が消えていて印を 404 で断られたら、読み直して行を外し、見出しにフォーカスを置く', async ({ page }) => {
  const tasks = [row('消えた行', { due_on: '2026-11-06' }), row('残る行', { due_on: '2026-11-06' })];
  await routeOperation(page, today, { slug: 'aoba' }, (call) => call.fulfill({ tasks, sprint_goals: [] }));
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, (call) => {
    removeTask(tasks, call.input.task_id);
    return call.fail(404, 'not_found');
  });
  await page.goto('/aoba');

  await page.getByRole('button', { name: '今日やる: 消えた行' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'このタスクは見つかりません' })).toBeVisible();
  await expect(page.locator('.entry-title')).toHaveText(['残る行']);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeFocused();
});

test('完了を 409 の conflict で断られたとき、読み直して完了していれば「すでに完了」、行が外れていれば「見つかりません」、未完了のままなら失敗の知らせを出す', async ({
  page,
}) => {
  const tasks = [
    row('先に完了された', { today_on: TODAY }),
    row('読み取りから外れた', { today_on: TODAY }),
    row('競合に負け続けた', { today_on: TODAY }),
  ];
  await routeOperation(page, today, { slug: 'aoba' }, (call) => call.fulfill({ tasks, sprint_goals: [] }));
  await routeOperation(page, taskComplete, { slug: 'aoba' }, (call) => {
    if (call.input.task_id === '先に完了された') {
      // 別の画面が先に完了にした
      Object.assign(tasks[0]!, {
        completed_at: '2026-11-04T01:00:00.000Z',
        is_today_completed: true,
        reopenable: true,
      });
    }
    if (call.input.task_id === '読み取りから外れた') {
      // 日付をまたいだ後に別の画面で完了にされ、今日の読み取りに載らなくなった
      removeTask(tasks, '読み取りから外れた');
    }
    return call.fail(409, 'conflict');
  });
  await page.goto('/aoba');

  await page.getByRole('button', { name: '完了にする: 先に完了された' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'このタスクは、すでに完了です' })).toBeVisible();
  await expect(region(page, '今日の完了').locator('.entry-title')).toHaveText(['先に完了された']);

  await page.getByRole('button', { name: '完了にする: 読み取りから外れた' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'このタスクは見つかりません' })).toBeVisible();

  await page.getByRole('button', { name: '完了にする: 競合に負け続けた' }).click();
  await expect(page.getByRole('status').filter({ hasText: '完了にできませんでした' })).toBeVisible();
  await expect(region(page, '今日の完了').locator('.entry-title')).toHaveText(['先に完了された']);
  await expect(page.getByRole('button', { name: '完了にする: 競合に負け続けた' })).toBeFocused();
});

test('完了を 409 の conflict で断られた後に今日を読み直せなかったときは、行が消えたとは言わず完了にできなかった旨を知らせる', async ({
  page,
}) => {
  const tasks = [row('読み直せない行', { today_on: TODAY })];
  let readable = true;
  await routeOperation(page, today, { slug: 'aoba' }, (call) =>
    readable ? call.fulfill({ tasks, sprint_goals: [] }) : call.fail(500, 'internal'),
  );
  await routeOperation(page, taskComplete, { slug: 'aoba' }, (call) => {
    readable = false;
    return call.fail(409, 'conflict');
  });
  await page.goto('/aoba');

  await page.getByRole('button', { name: '完了にする: 読み直せない行' }).click();
  await expect(page.getByRole('status').filter({ hasText: '完了にできませんでした' })).toBeVisible();
  await expect(page.getByText('このタスクは見つかりません')).toHaveCount(0);
});
