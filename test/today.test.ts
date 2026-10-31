// 今日やること（today）の読み取り。呼んだ人が今所属する、閉じていないワークスペースの、担当するバックログのタスクのうち、
// 今日やることの画面のどれかの区分に入りうるものを返す。区分への振り分けと並べ替えは画面（src/lib/today-sections.ts）が行うので、
// ここでは「どのタスクが返るか」と、画面が振り分けに使う値（today、week_start、carry_days、sprint_active、is_today_completed）を確かめる。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { today } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createBoardColumn,
  createMembership,
  createOrganization,
  createRepository,
  createSprint,
  createTask,
  createUser,
  createWorkspace,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person } from './operations/world.ts';

const app = createApp(implementedOperations);

// 2026-11-01（日）12:00 の東京。ロサンゼルスはまだ 10-31（土）20:00（夏時間の終わりは 11-01 の現地 2:00）
const NOW = new Date('2026-11-01T03:00:00.000Z');
const TOKYO = 'Asia/Tokyo';
const LOS_ANGELES = 'America/Los_Angeles';

type TodayTaskView = {
  id: string;
  title: string;
  points: number | null;
  due_on: string | null;
  today_on: string | null;
  completed_at: string | null;
  workspace_id: string;
  workspace_name: string;
  today: string;
  week_start: number;
  position: string;
  carry_days: number;
  sprint_active: boolean;
  is_today_completed: boolean;
  assignee: { id: string; name: string } | null;
  repository: { id: string; name: string } | null;
  sprint: { id: string; name: string | null; start_on: string; end_on: string } | null;
};
type TodayView = {
  tasks: TodayTaskView[];
  sprint_goals: { workspace_id: string; workspace_name: string; goal: string }[];
};

beforeEach(() => {
  // Date だけを止める（D1 や setTimeout は実時間のまま）
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function readToday(slug: string, person: Person): Promise<TodayView> {
  const res = await post(app, today, { slug, token: person.token });
  expect(res.status).toBe(200);
  return (await res.json()) as TodayView;
}

const titlesOf = (view: TodayView) => view.tasks.map((task) => task.title).sort();

type Workspace = Awaited<ReturnType<typeof createWorkspace>>;

// 組織と、管理者と、本人（me）。タスクは、ことわりが無ければ me の担当のバックログに作る
async function createWorld() {
  const organization = await createOrganization();
  const admin = await createPerson({ organization, admin: true });
  const me = await createPerson({ organization });
  const colleague = await createPerson({ organization });

  async function workspace(overrides: Parameters<typeof createWorkspace>[2] = {}, options: { join?: boolean } = {}) {
    const created = await createWorkspace(organization, admin.userId!, overrides);
    if (options.join !== false) {
      await createMembership(organization, created.id, me.userId!);
      await createMembership(organization, created.id, colleague.userId!);
    }
    return created;
  }

  async function task(ws: Workspace, overrides: Parameters<typeof createTask>[3] = {}) {
    return createTask(organization, ws.id, admin.userId!, { assignee_user_id: me.userId, ...overrides });
  }

  // スプリントに入れるには列が要る（sprint_id と column_id は同時に入る）
  async function sprintTask(ws: Workspace, sprintId: string, overrides: Parameters<typeof createTask>[3] = {}) {
    const column = await createBoardColumn(organization, ws.id);
    return task(ws, { sprint_id: sprintId, column_id: column.id, column_position: 'a0', ...overrides });
  }

  return {
    organization,
    admin,
    me,
    colleague,
    workspace,
    task,
    sprintTask,
    read: () => readToday(organization.slug, me),
  };
}

describe('today: 返すタスクの範囲', () => {
  test('2つのワークスペースに所属する人の、両方の担当タスクが出る。行にワークスペースの ID と名前が付く', async () => {
    const world = await createWorld();
    const asahi = await world.workspace({ name: 'あさひ班' });
    const aoba = await world.workspace({ name: '青葉チーム' });
    await world.task(asahi, { title: 'あさひの見積もり', today_on: '2026-11-01' });
    await world.task(aoba, { title: '青葉の請求書', today_on: '2026-11-01' });

    const view = await world.read();

    expect(titlesOf(view)).toEqual(['あさひの見積もり', '青葉の請求書']);
    const byTitle = Object.fromEntries(view.tasks.map((task) => [task.title, task]));
    expect(byTitle['あさひの見積もり']).toMatchObject({ workspace_id: asahi.id, workspace_name: 'あさひ班' });
    expect(byTitle['青葉の請求書']).toMatchObject({ workspace_id: aoba.id, workspace_name: '青葉チーム' });
  });

  test('ほかの人のタスク、担当のないタスク、受信箱とアーカイブのタスクは出ない', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    await world.task(ws, { title: '自分のタスク', today_on: '2026-11-01' });
    await world.task(ws, { title: '同僚のタスク', today_on: '2026-11-01', assignee_user_id: world.colleague.userId });
    await world.task(ws, { title: '担当なしのタスク', today_on: '2026-11-01', assignee_user_id: null });
    await world.task(ws, { title: '受信箱のタスク', today_on: '2026-11-01', tray: 'inbox', is_imported: 1 });
    await world.task(ws, { title: 'アーカイブのタスク', today_on: '2026-11-01', tray: 'archive', is_imported: 1 });

    expect(titlesOf(await world.read())).toEqual(['自分のタスク']);
  });

  test('同僚が呼ぶと、同僚の担当のタスクだけが出る', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    await world.task(ws, { title: '自分のタスク', today_on: '2026-11-01' });
    await world.task(ws, { title: '同僚のタスク', today_on: '2026-11-01', assignee_user_id: world.colleague.userId });

    const view = await readToday(world.organization.slug, world.colleague);

    expect(titlesOf(view)).toEqual(['同僚のタスク']);
  });

  test('削除したタスクは出ない', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    await world.task(ws, { title: '生きているタスク', today_on: '2026-11-01' });
    await world.task(ws, { title: '削除したタスク', today_on: '2026-11-01', deleted_at: '2026-10-30T00:00:00.000Z' });

    expect(titlesOf(await world.read())).toEqual(['生きているタスク']);
  });

  test('所属を外れたワークスペースと、閉じたワークスペースのタスクは出ない', async () => {
    const world = await createWorld();
    const active = await world.workspace({ name: '今いる班' });
    const closed = await world.workspace({ name: '閉じた班', closed_at: '2026-10-22T00:00:00.000Z' });
    const left = await world.workspace({ name: '抜けた班' }, { join: false });
    await createMembership(world.organization, left.id, world.me.userId!, {
      left_on: '2026-10-20',
      left_at: '2026-10-20T00:00:00.000Z',
    });
    const never = await world.workspace({ name: '入っていない班' }, { join: false });
    for (const ws of [active, closed, left, never]) {
      await world.task(ws, { title: `${ws.name}のタスク`, today_on: '2026-11-01' });
    }

    expect(titlesOf(await world.read())).toEqual(['今いる班のタスク']);
  });

  test('抜けて入り直したワークスペースのタスクは、1件だけ出る', async () => {
    const world = await createWorld();
    const ws = await world.workspace({}, { join: false });
    await createMembership(world.organization, ws.id, world.me.userId!, {
      joined_on: '2026-09-01',
      left_on: '2026-09-30',
      left_at: '2026-09-30T00:00:00.000Z',
    });
    await createMembership(world.organization, ws.id, world.me.userId!, { joined_on: '2026-10-10' });
    await world.task(ws, { title: '入り直したあとのタスク', today_on: '2026-11-01' });

    expect(titlesOf(await world.read())).toEqual(['入り直したあとのタスク']);
  });

  test('同じタスクが複数の条件に当てはまっても、1件だけ返る', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    const sprint = await createSprint(world.organization, ws.id, { status: 'active' });
    await world.sprintTask(ws, sprint.id, {
      title: 'どの条件にも当てはまる',
      due_on: '2026-10-30',
      today_on: '2026-10-31',
    });

    const view = await world.read();

    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]).toMatchObject({ title: 'どの条件にも当てはまる', sprint_active: true, carry_days: 1 });
  });

  test('タスクの行は、画面が表示に使う担当、リポジトリ、スプリントを持つ。削除したリポジトリとスプリントは null', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    const repository = await createRepository(world.organization, ws.id, { name: 'shop-api' });
    const deletedRepository = await createRepository(world.organization, ws.id, {
      name: '消したリポジトリ',
      deleted_at: '2026-10-01T00:00:00.000Z',
    });
    const sprint = await createSprint(world.organization, ws.id, {
      status: 'active',
      name: '第3スプリント',
      start_on: '2026-10-26',
      end_on: '2026-11-08',
    });
    const deletedSprint = await createSprint(world.organization, ws.id, {
      status: 'active',
      deleted_at: '2026-10-01T00:00:00.000Z',
    });
    await world.sprintTask(ws, sprint.id, {
      title: '全部入りのタスク',
      points: 5,
      repository_id: repository.id,
      position: 'a1',
    });
    await world.task(ws, {
      title: '消したリポジトリのタスク',
      repository_id: deletedRepository.id,
      today_on: '2026-11-01',
    });
    await world.sprintTask(ws, deletedSprint.id, { title: '消したスプリントのタスク', today_on: '2026-11-01' });

    const view = await world.read();
    const byTitle = Object.fromEntries(view.tasks.map((task) => [task.title, task]));

    expect(byTitle['全部入りのタスク']).toMatchObject({
      points: 5,
      position: 'a1',
      assignee: { id: world.me.userId, name: '星野 澪' },
      repository: { id: repository.id, name: 'shop-api' },
      sprint: { id: sprint.id, name: '第3スプリント', start_on: '2026-10-26', end_on: '2026-11-08' },
      sprint_active: true,
    });
    expect(byTitle['消したリポジトリのタスク']?.repository).toBeNull();
    expect(byTitle['消したスプリントのタスク']).toMatchObject({ sprint: null, sprint_active: false });
  });
});

describe('today: 別の組織', () => {
  test('別の組織のタスクは出ない。同じアカウントが2つの組織にいても、呼んだ組織のタスクだけが出る', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    await world.task(ws, { title: 'こちらの組織のタスク', today_on: '2026-11-01' });

    // 同じアカウントが、別の組織にも users の行を持つ
    const elsewhere = await createOrganization();
    const elsewhereAdmin = await createPerson({ organization: elsewhere, admin: true });
    const elsewhereUser = await createUser(elsewhere, {
      account_id: world.me.accountId,
      login_provider: world.me.login.provider,
      login_subject: `${world.me.login.subject}-elsewhere`,
    });
    const elsewhereWorkspace = await createWorkspace(elsewhere, elsewhereAdmin.userId!, { name: '別の組織の班' });
    await createMembership(elsewhere, elsewhereWorkspace.id, elsewhereUser.id);
    await createTask(elsewhere, elsewhereWorkspace.id, elsewhereAdmin.userId!, {
      title: '別の組織のタスク',
      assignee_user_id: elsewhereUser.id,
      today_on: '2026-11-01',
    });
    await createSprint(elsewhere, elsewhereWorkspace.id, { status: 'active', goal: '別の組織のゴール' });

    const own = await readToday(world.organization.slug, world.me);
    const other = await readToday(elsewhere.slug, world.me);

    expect(titlesOf(own)).toEqual(['こちらの組織のタスク']);
    expect(own.sprint_goals).toEqual([]);
    expect(titlesOf(other)).toEqual(['別の組織のタスク']);
    expect(other.sprint_goals.map((goal) => goal.goal)).toEqual(['別の組織のゴール']);
  });
});

describe('today: 区分に入るタスクの境界', () => {
  // 東京の 2026-11-01（日）。週の始まりを日曜にすると今週は 11-01〜11-07、月曜にすると 10-26〜11-01
  test('期日切れ、今週が期日、今日やると決めたもの、進行中のスプリントのタスクが返り、それ以外は返らない', async () => {
    const world = await createWorld();
    const ws = await world.workspace({ timezone: TOKYO, week_start: 0 });
    const planned = await createSprint(world.organization, ws.id, { status: 'planned' });
    const closed = await createSprint(world.organization, ws.id, { status: 'closed' });
    const active = await createSprint(world.organization, ws.id, { status: 'active' });

    await world.task(ws, { title: '期日切れ', due_on: '2026-10-31' });
    await world.task(ws, { title: '今週の終わりが期日', due_on: '2026-11-07' });
    await world.task(ws, { title: '来週が期日', due_on: '2026-11-08' });
    await world.task(ws, { title: '期日も印も無い' });
    await world.task(ws, { title: '今日やると決めた', today_on: '2026-11-01' });
    await world.task(ws, { title: '期日が先でも印がある', due_on: '2026-12-01', today_on: '2026-11-01' });
    await world.task(ws, { title: '期日が過ぎても印がある', due_on: '2026-10-01', today_on: '2026-11-01' });
    await world.sprintTask(ws, active.id, { title: '進行中のスプリント（期日なし）' });
    await world.sprintTask(ws, active.id, { title: '進行中のスプリント（期日が先）', due_on: '2026-12-01' });
    await world.sprintTask(ws, planned.id, { title: '計画中のスプリント' });
    await world.sprintTask(ws, closed.id, { title: '終えたスプリント' });

    expect(titlesOf(await world.read())).toEqual(
      [
        '期日切れ',
        '今週の終わりが期日',
        '今日やると決めた',
        '期日が先でも印がある',
        '期日が過ぎても印がある',
        '進行中のスプリント（期日なし）',
        '進行中のスプリント（期日が先）',
      ].sort(),
    );
  });

  // 今日が期日の印の無いタスクは「今週が期日」に入る（docs/requirements.md の「今日やること」）。
  test('今日が期日で、印も進行中のスプリントも無いタスクが返る', async () => {
    const world = await createWorld();
    const ws = await world.workspace({ timezone: TOKYO, week_start: 1 });
    await world.task(ws, { title: '今日が期日', due_on: '2026-11-01' });

    expect(titlesOf(await world.read())).toEqual(['今日が期日']);
  });

  test('完了したタスクは、完了が今日のものだけ返る。印、期日切れ、進行中のスプリントがあっても、昨日までの完了は返らない', async () => {
    const world = await createWorld();
    const ws = await world.workspace({ timezone: TOKYO });
    const active = await createSprint(world.organization, ws.id, { status: 'active' });
    // 東京の今日は 2026-11-01（UTC の 10-31 15:00 から 11-01 14:59:59 まで）
    const finished = {
      today_on: '2026-10-30',
      due_on: '2026-10-30',
    };
    await world.task(ws, { title: '今日の始まりに完了', completed_at: '2026-10-31T15:00:00.000Z', ...finished });
    await world.task(ws, { title: '今日の終わりに完了', completed_at: '2026-11-01T14:59:59.999Z', ...finished });
    await world.task(ws, { title: '昨日の終わりに完了', completed_at: '2026-10-31T14:59:59.999Z', ...finished });
    await world.task(ws, { title: '明日の始まりに完了', completed_at: '2026-11-01T15:00:00.000Z', ...finished });
    await world.sprintTask(ws, active.id, {
      title: 'スプリント内で昨日完了',
      completed_at: '2026-10-30T01:00:00.000Z',
    });
    await world.sprintTask(ws, active.id, {
      title: 'スプリント内で今日完了',
      completed_at: '2026-11-01T01:00:00.000Z',
    });

    const view = await world.read();

    expect(titlesOf(view)).toEqual(['スプリント内で今日完了', '今日の始まりに完了', '今日の終わりに完了']);
    expect(view.tasks.every((task) => task.is_today_completed)).toBe(true);
  });

  test('2日より前の完了は返らず、時差が最も大きいワークスペースの今日の完了は返る', async () => {
    const world = await createWorld();
    // UTC+14。NOW（UTC の 11-01 03:00）の現地は 11-01 17:00 で、現地の今日は UTC の 10-31 10:00 から始まる
    const kiritimati = await world.workspace({ name: '最も東の班', timezone: 'Pacific/Kiritimati' });
    // UTC−12。現地は 10-31 15:00 で、現地の今日は UTC の 10-31 12:00 から始まる
    const baker = await world.workspace({ name: '最も西の班', timezone: 'Etc/GMT+12' });
    await world.task(kiritimati, { title: '東の今日の始まりに完了', completed_at: '2026-10-31T10:00:00.000Z' });
    await world.task(kiritimati, { title: '東の昨日に完了', completed_at: '2026-10-31T09:59:59.999Z' });
    await world.task(baker, { title: '西の今日の始まりに完了', completed_at: '2026-10-31T12:00:00.000Z' });
    await world.task(baker, { title: '西の昨日に完了', completed_at: '2026-10-31T11:59:59.999Z' });
    await world.task(baker, { title: '3日前に完了', completed_at: '2026-10-29T03:00:00.000Z' });
    await world.task(baker, { title: '1年前に完了', completed_at: '2025-11-01T03:00:00.000Z', today_on: '2025-11-01' });

    expect(titlesOf(await world.read())).toEqual(['東の今日の始まりに完了', '西の今日の始まりに完了'].sort());
  });

  test('UTC−12 のワークスペースは、現地の今日の始まりに完了したタスクを、現地の今日が終わる直前まで返す', async () => {
    const world = await createWorld();
    const baker = await world.workspace({ timezone: 'Etc/GMT+12' });
    // 現地は 10-31 23:59:59。現地の今日の始まり（UTC の 10-31 12:00）から 24 時間近く経つ
    vi.setSystemTime(new Date('2026-11-01T11:59:59.000Z'));
    await world.task(baker, { title: '今日の始まりに完了', completed_at: '2026-10-31T12:00:00.000Z' });

    const view = await world.read();

    expect(titlesOf(view)).toEqual(['今日の始まりに完了']);
    expect(view.tasks[0]).toMatchObject({ is_today_completed: true });
  });

  test('UTC+14 のワークスペースは、現地の今日の始まりに完了したタスクを、現地の今日が終わる直前まで返す', async () => {
    const world = await createWorld();
    const kiritimati = await world.workspace({ timezone: 'Pacific/Kiritimati' });
    // 現地は 11-02 の直前（UTC の 11-02 09:59:59 は現地の 11-02 23:59:59）。現地の今日の始まりは UTC の 11-01 10:00
    vi.setSystemTime(new Date('2026-11-02T09:59:59.000Z'));
    await world.task(kiritimati, { title: '今日の始まりに完了', completed_at: '2026-11-01T10:00:00.000Z' });

    const view = await world.read();

    expect(titlesOf(view)).toEqual(['今日の始まりに完了']);
    expect(view.tasks[0]).toMatchObject({ is_today_completed: true });
  });

  test('今日完了した行は、前日に印を付けていても carry_days が 0（完了した印は区分に使わない）', async () => {
    const world = await createWorld();
    const ws = await world.workspace({ timezone: TOKYO });
    await world.task(ws, {
      title: '昨日印を付けて今日完了',
      today_on: '2026-10-31',
      completed_at: '2026-11-01T01:00:00.000Z',
    });
    await world.task(ws, { title: '昨日印を付けて未完了', today_on: '2026-10-31' });

    const days = Object.fromEntries((await world.read()).tasks.map((task) => [task.title, task.carry_days]));

    expect(days).toEqual({ 昨日印を付けて今日完了: 0, 昨日印を付けて未完了: 1 });
  });

  test('未完了のタスクは is_today_completed が偽', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    await world.task(ws, { title: '未完了', today_on: '2026-11-01' });

    expect((await world.read()).tasks[0]).toMatchObject({ completed_at: null, is_today_completed: false });
  });
});

describe('today: ワークスペースのタイムゾーンと週の始まり', () => {
  test('今日と週の始まりは、タスクが属するワークスペースの値で行に付く', async () => {
    const world = await createWorld();
    const tokyo = await world.workspace({ name: '東京の班', timezone: TOKYO, week_start: 1 });
    const losAngeles = await world.workspace({ name: 'LA の班', timezone: LOS_ANGELES, week_start: 0 });
    await world.task(tokyo, { title: '東京', today_on: '2026-11-01' });
    await world.task(losAngeles, { title: 'LA', today_on: '2026-11-01' });

    const byTitle = Object.fromEntries((await world.read()).tasks.map((task) => [task.title, task]));

    expect(byTitle['東京']).toMatchObject({ today: '2026-11-01', week_start: 1 });
    expect(byTitle['LA']).toMatchObject({ today: '2026-10-31', week_start: 0 });
  });

  test('今日の日付の境: 同じ完了の時刻でも、ワークスペースのタイムゾーンで今日かどうかが分かれる', async () => {
    const world = await createWorld();
    const tokyo = await world.workspace({ name: '東京の班', timezone: TOKYO });
    const losAngeles = await world.workspace({ name: 'LA の班', timezone: LOS_ANGELES });
    // 2026-10-31T10:00Z は東京で 10-31 19:00（昨日）、LA で 10-31 03:00（今日）
    const yesterdayInTokyo = '2026-10-31T10:00:00.000Z';
    // 2026-11-01T08:00Z は東京で 11-01 17:00（今日）、LA で 11-01 01:00（明日）
    const tomorrowInLosAngeles = '2026-11-01T08:00:00.000Z';
    await world.task(tokyo, { title: '東京で昨日', completed_at: yesterdayInTokyo });
    await world.task(losAngeles, { title: 'LA で今日', completed_at: yesterdayInTokyo });
    await world.task(tokyo, { title: '東京で今日', completed_at: tomorrowInLosAngeles });
    await world.task(losAngeles, { title: 'LA で明日', completed_at: tomorrowInLosAngeles });

    expect(titlesOf(await world.read())).toEqual(['LA で今日', '東京で今日']);
  });

  test('今週の判定は、ワークスペースの週の始まりで分かれる', async () => {
    const world = await createWorld();
    // 東京の 11-01 は日曜。週の始まりが日曜なら今週は 11-01〜11-07、月曜なら 10-26〜11-01
    const sundayStart = await world.workspace({ name: '日曜始まり', timezone: TOKYO, week_start: 0 });
    const mondayStart = await world.workspace({ name: '月曜始まり', timezone: TOKYO, week_start: 1 });
    await world.task(sundayStart, { title: '日曜始まりの11-05', due_on: '2026-11-05' });
    await world.task(mondayStart, { title: '月曜始まりの11-05', due_on: '2026-11-05' });
    // 同じタイムゾーンでも、月曜始まりの 11-01 は今週の最終日、11-02 は来週
    await world.task(mondayStart, { title: '月曜始まりの11-02', due_on: '2026-11-02' });
    await world.task(sundayStart, { title: '日曜始まりの11-02', due_on: '2026-11-02' });

    expect(titlesOf(await world.read())).toEqual(['日曜始まりの11-02', '日曜始まりの11-05']);
  });

  test('今週の判定は、ワークスペースのタイムゾーンで分かれる', async () => {
    const world = await createWorld();
    // LA の今日は 10-31（土）。週の始まりが月曜なら今週は 10-26〜11-01、日曜なら 10-25〜10-31
    const mondayStart = await world.workspace({ name: 'LA 月曜始まり', timezone: LOS_ANGELES, week_start: 1 });
    const sundayStart = await world.workspace({ name: 'LA 日曜始まり', timezone: LOS_ANGELES, week_start: 0 });
    await world.task(mondayStart, { title: 'LA 月曜始まりの11-01', due_on: '2026-11-01' });
    await world.task(sundayStart, { title: 'LA 日曜始まりの11-01', due_on: '2026-11-01' });
    // 東京ではすでに 11-01 なので、同じ期日の 10-31 は期日切れ
    const tokyo = await world.workspace({ name: '東京', timezone: TOKYO, week_start: 1 });
    await world.task(tokyo, { title: '東京の10-31', due_on: '2026-10-31' });
    await world.task(mondayStart, { title: 'LA 月曜始まりの11-02', due_on: '2026-11-02' });

    expect(titlesOf(await world.read())).toEqual(['LA 月曜始まりの11-01', '東京の10-31']);
  });
});

describe('today: 持ち越し', () => {
  test('印を付けた日から今日までの日数を返す。今日以降の印は 0。月をまたいでも数える', async () => {
    const world = await createWorld();
    const ws = await world.workspace({ timezone: TOKYO });
    await world.task(ws, { title: '今日付けた', today_on: '2026-11-01' });
    await world.task(ws, { title: '昨日付けた', today_on: '2026-10-31' });
    await world.task(ws, { title: '3日前に付けた', today_on: '2026-10-29' });
    await world.task(ws, { title: '前の月に付けた', today_on: '2026-09-30' });
    await world.task(ws, { title: '明日付け', today_on: '2026-11-02' });

    const days = Object.fromEntries((await world.read()).tasks.map((task) => [task.title, task.carry_days]));

    expect(days).toEqual({
      今日付けた: 0,
      昨日付けた: 1,
      '3日前に付けた': 3,
      前の月に付けた: 32,
      明日付け: 0,
    });
  });

  test('遠い過去の印でも、日数を正しく数えて返す', async () => {
    const world = await createWorld();
    const ws = await world.workspace({ timezone: TOKYO });
    await world.task(ws, { title: '最も古い印', today_on: '0001-01-01' });

    const view = await world.read();

    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]).toMatchObject({ today_on: '0001-01-01', carry_days: 739_920 });
  });

  test('持ち越しの日数は、ワークスペースのタイムゾーンの今日から数える', async () => {
    const world = await createWorld();
    const tokyo = await world.workspace({ name: '東京の班', timezone: TOKYO });
    const losAngeles = await world.workspace({ name: 'LA の班', timezone: LOS_ANGELES });
    await world.task(tokyo, { title: '東京', today_on: '2026-10-31' });
    await world.task(losAngeles, { title: 'LA', today_on: '2026-10-31' });

    const days = Object.fromEntries((await world.read()).tasks.map((task) => [task.title, task.carry_days]));

    expect(days).toEqual({ 東京: 1, LA: 0 });
  });

  test('印を付けた日が過ぎた未完了のタスクは、期日が過ぎていても自動では外れず返る', async () => {
    const world = await createWorld();
    const ws = await world.workspace({ timezone: TOKYO });
    await world.task(ws, { title: '古い印', today_on: '2026-09-01', due_on: '2026-09-05' });

    const view = await world.read();

    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]).toMatchObject({ today_on: '2026-09-01', carry_days: 61 });
  });
});

describe('today: 並べ替えに使う値', () => {
  // 並べ替え（期日の早い順、期日なしは最後、同じ期日はワークスペースの並び、その中はバックログの並び）は画面が行う。
  // 操作の応答は並びを約束しないので、画面が並べるのに要る値が全部そろうことを確かめる
  test('期日、ワークスペースの名前、バックログの位置、持ち越しの日数が行に付く', async () => {
    const world = await createWorld();
    const asahi = await world.workspace({ name: 'あさひ班' });
    const aoba = await world.workspace({ name: '青葉チーム' });
    await world.task(asahi, { title: 'あさひ1', today_on: '2026-10-30', due_on: '2026-11-03', position: 'a1' });
    await world.task(aoba, { title: '青葉1', today_on: '2026-11-01', position: 'a0' });

    const byTitle = Object.fromEntries((await world.read()).tasks.map((task) => [task.title, task]));

    expect(byTitle['あさひ1']).toMatchObject({
      due_on: '2026-11-03',
      workspace_name: 'あさひ班',
      position: 'a1',
      carry_days: 2,
    });
    expect(byTitle['青葉1']).toMatchObject({
      due_on: null,
      workspace_name: '青葉チーム',
      position: 'a0',
      carry_days: 0,
    });
  });
});

describe('today: 進行中のスプリントのゴール', () => {
  test('ゴールを書いた進行中のスプリントだけが、ワークスペース名とともに返る', async () => {
    const world = await createWorld();
    const withGoal = await world.workspace({ name: 'ゴールのある班' });
    const emptyGoal = await world.workspace({ name: '空のゴールの班' });
    const nullGoal = await world.workspace({ name: 'ゴールの無い班' });
    const planned = await world.workspace({ name: '計画中の班' });
    const closedSprint = await world.workspace({ name: '終えたスプリントの班' });
    const deletedSprint = await world.workspace({ name: '削除したスプリントの班' });
    await createSprint(world.organization, withGoal.id, { status: 'active', goal: '請求の画面を出す' });
    await createSprint(world.organization, emptyGoal.id, { status: 'active', goal: '' });
    await createSprint(world.organization, nullGoal.id, { status: 'active', goal: null });
    await createSprint(world.organization, planned.id, { status: 'planned', goal: '計画中のゴール' });
    await createSprint(world.organization, closedSprint.id, { status: 'closed', goal: '終えたゴール' });
    await createSprint(world.organization, deletedSprint.id, {
      status: 'active',
      goal: '削除したゴール',
      deleted_at: '2026-10-30T00:00:00.000Z',
    });

    const view = await world.read();

    expect(view.sprint_goals).toEqual([
      { workspace_id: withGoal.id, workspace_name: 'ゴールのある班', goal: '請求の画面を出す' },
    ]);
  });

  test('閉じたワークスペースのゴールは返らない', async () => {
    const world = await createWorld();
    const open = await world.workspace({ name: '開いている班' });
    const closed = await world.workspace({ name: '閉じた班', closed_at: '2026-10-22T00:00:00.000Z' });
    await createSprint(world.organization, open.id, { status: 'active', goal: '開いている班のゴール' });
    await createSprint(world.organization, closed.id, { status: 'active', goal: '閉じた班のゴール' });

    expect((await world.read()).sprint_goals.map((goal) => goal.goal)).toEqual(['開いている班のゴール']);
  });

  test('タスクが無くても、所属するワークスペースのゴールは返る', async () => {
    const world = await createWorld();
    const ws = await world.workspace();
    await createSprint(world.organization, ws.id, { status: 'active', goal: 'ゴールだけ' });

    const view = await world.read();

    expect(view.tasks).toEqual([]);
    expect(view.sprint_goals.map((goal) => goal.goal)).toEqual(['ゴールだけ']);
  });

  // Issue #671 は「所属する閉じていないワークスペースの進行中のスプリント」のゴールを返すと決めている。
  test('所属していない、または抜けたワークスペースのゴールは返らない', async () => {
    const world = await createWorld();
    const member = await world.workspace({ name: '所属する班' });
    const left = await world.workspace({ name: '抜けた班' }, { join: false });
    await createMembership(world.organization, left.id, world.me.userId!, {
      left_on: '2026-10-20',
      left_at: '2026-10-20T00:00:00.000Z',
    });
    const never = await world.workspace({ name: '入っていない班' }, { join: false });
    await createSprint(world.organization, member.id, { status: 'active', goal: '所属する班のゴール' });
    await createSprint(world.organization, left.id, { status: 'active', goal: '抜けた班のゴール' });
    await createSprint(world.organization, never.id, { status: 'active', goal: '入っていない班のゴール' });

    expect((await world.read()).sprint_goals.map((goal) => goal.goal)).toEqual(['所属する班のゴール']);
  });
});

describe('today: 権限', () => {
  test('ワークスペースに所属しない管理者には、空の一覧を返す', async () => {
    const world = await createWorld();
    const ws = await world.workspace({}, { join: false });
    await world.task(ws, { title: '管理者の担当', assignee_user_id: world.admin.userId, today_on: '2026-11-01' });

    const view = await readToday(world.organization.slug, world.admin);

    expect(view.tasks).toEqual([]);
  });

  test('どのワークスペースにも所属しない管理者でない人は、組織に入れず 404', async () => {
    const world = await createWorld();
    const nobody = await createPerson({ organization: world.organization });

    const res = await post(app, today, { slug: world.organization.slug, token: nobody.token });

    expect(res.status).toBe(404);
  });

  test('ログインしていないと 401、承諾待ちの招待だけの人には 404', async () => {
    const target = await createTarget();

    const anonymous = await post(app, today, { slug: target.slug });
    expect(anonymous.status).toBe(401);
    expect(await errorCodeOf(anonymous)).toBe('unauthenticated');

    const invitee = await post(app, today, { slug: target.slug, token: target.invitee.token });
    expect(invitee.status).toBe(404);
  });

  test('別の組織の人は、この組織の slug で呼んでも 404', async () => {
    const target = await createTarget();
    const outsider = await createTarget();

    const res = await post(app, today, { slug: target.slug, token: outsider.member.token });

    expect(res.status).toBe(404);
  });
});
