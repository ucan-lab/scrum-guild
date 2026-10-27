// バックログの木の絞り込みと検索（backlog-tree の assignee_user_id、category_id、repository_id、epic_id、query）。
// 当たり方（タスクで決め、親を道筋として残す。区分、エピック、検索は親にも当てる。担当とリポジトリで絞ると空の親を出さない）、
// 集計が全体の値のままであること、担当の選択肢、別の組織と別のワークスペースの ID が何にも当たらないことを確かめる。
// 絞らないときの木の形は test/task.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { backlogTree } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { queryPlanForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { openStoryTasksStatement } from '../src/server/operations/task.ts';
import {
  AT,
  createCategory,
  createEpic,
  createMembership,
  createRepository,
  createStory,
  createTask,
  createUser,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Ref = { id: string; name: string } | null;
type TaskRow = { id: string; title: string; assignee: { id: string } | null; repository: Ref; category: Ref };
type StoryRow = {
  id: string;
  tasks: TaskRow[];
  completed_task_count: number;
  open_task_count: number;
  points_done: number;
  points_all: number;
};
type TreeBody = {
  epics: { id: string; stories: StoryRow[]; points_done: number; points_all: number }[];
  stories: StoryRow[];
  tasks: TaskRow[];
  completed_count: number | null;
  choices: {
    assignees: { id: string; name: string; current: boolean }[];
    epics: { id: string; title: string; finished: boolean }[];
    stories: { id: string; title: string; epic_id: string | null; category: Ref }[] | null;
  };
};

type Filter = {
  assignee_user_id?: string | null;
  category_id?: string | null;
  repository_id?: string | null;
  epic_id?: string | null;
  query?: string;
};

async function tree(target: Target, filter: Filter = {}, person: Person = target.member) {
  return post(app, backlogTree, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...filter },
  });
}

async function treeBody(target: Target, filter: Filter = {}, person?: Person): Promise<TreeBody> {
  const res = await tree(target, filter, person);
  expect(res.status).toBe(200);
  return (await res.json()) as TreeBody;
}

// 木の形を、エピック > ストーリー > タスクの ID の入れ子で見る
function shape(body: TreeBody) {
  const storyShape = (story: StoryRow) => ({ [story.id]: story.tasks.map((task) => task.id) });
  return {
    epics: body.epics.map((epic) => ({ [epic.id]: epic.stories.map(storyShape) })),
    stories: body.stories.map(storyShape),
    tasks: body.tasks.map((task) => task.id),
  };
}

// 2つのエピック（区分ありとなし）、エピックの下と親のないストーリー（空のものも）、親のないタスクのあるワークスペース
async function world() {
  const target = await createTarget();
  const { organization } = target;
  const workspaceId = target.workspace.id;
  const adminId = target.admin.userId!;
  const leaderId = target.leader.userId!;
  const memberId = target.member.userId!;
  const upkeep = await createCategory(organization, workspaceId, { name: '保守', position: 'a0' });
  const extra = await createCategory(organization, workspaceId, { name: '追加案件', position: 'a1' });
  const shopApi = await createRepository(organization, workspaceId, { name: 'shop-api', position: 'a0' });
  const shopWeb = await createRepository(organization, workspaceId, { name: 'shop-web', position: 'a1' });
  const points = await createEpic(organization, workspaceId, adminId, {
    title: '会員ポイント制度を公開する',
    category_id: upkeep.id,
    position: 'a0',
  });
  const payment = await createEpic(organization, workspaceId, adminId, {
    title: '決済まわりの障害を減らす',
    position: 'a1',
  });
  const memberScreen = await createStory(organization, workspaceId, adminId, {
    title: '会員画面を作る',
    epic_id: points.id,
    position: 'a0',
  });
  const emptyUnderPoints = await createStory(organization, workspaceId, adminId, {
    title: '告知の段取り',
    epic_id: points.id,
    position: 'a1',
  });
  const refund = await createStory(organization, workspaceId, adminId, {
    title: '返金の流れを直す',
    epic_id: payment.id,
    position: 'a0',
  });
  const logs = await createStory(organization, workspaceId, adminId, {
    title: 'ログを整える',
    category_id: extra.id,
    position: 'a0',
  });
  const emptyRoot = await createStory(organization, workspaceId, adminId, {
    title: '空の目標',
    category_id: extra.id,
    position: 'a1',
  });
  const pointsApi = await createTask(organization, workspaceId, adminId, {
    title: 'ポイント表示の API',
    story_id: memberScreen.id,
    assignee_user_id: leaderId,
    repository_id: shopApi.id,
    points: 3,
    position: 'a0',
  });
  const wording = await createTask(organization, workspaceId, adminId, {
    title: '画面の文言',
    story_id: memberScreen.id,
    assignee_user_id: memberId,
    points: 2,
    position: 'a1',
  });
  // 完了したタスクは行を返さず、絞っても件数とポイントの合計に入る
  await createTask(organization, workspaceId, adminId, {
    title: 'ポイントの計算',
    story_id: memberScreen.id,
    assignee_user_id: leaderId,
    points: 5,
    completed_at: AT,
    completed_by: adminId,
    position: 'a2',
  });
  const refundApi = await createTask(organization, workspaceId, adminId, {
    title: '返金の API を直す',
    story_id: refund.id,
    repository_id: shopWeb.id,
    points: 8,
    position: 'a0',
  });
  const logStore = await createTask(organization, workspaceId, adminId, {
    title: 'ログの保存先',
    story_id: logs.id,
    assignee_user_id: leaderId,
    position: 'a0',
  });
  const mail = await createTask(organization, workspaceId, adminId, {
    title: 'メールの文面',
    category_id: upkeep.id,
    assignee_user_id: memberId,
    repository_id: shopApi.id,
    position: 'a0',
  });
  const percent = await createTask(organization, workspaceId, adminId, {
    title: '100% 対応_確認',
    position: 'a1',
  });
  await createTask(organization, workspaceId, adminId, {
    title: '親のない完了',
    completed_at: AT,
    completed_by: adminId,
    position: 'a2',
  });
  return {
    target,
    upkeep,
    extra,
    shopApi,
    shopWeb,
    points,
    payment,
    memberScreen,
    emptyUnderPoints,
    refund,
    logs,
    emptyRoot,
    pointsApi,
    wording,
    refundApi,
    logStore,
    mail,
    percent,
  };
}

describe('backlog-tree の絞り込み', () => {
  test('絞り込みを省くと、すべてを返し、親のない完了の件数と担当の選択肢も返す', async () => {
    const w = await world();
    const body = await treeBody(w.target);
    expect(shape(body)).toEqual({
      epics: [
        { [w.points.id]: [{ [w.memberScreen.id]: [w.pointsApi.id, w.wording.id] }, { [w.emptyUnderPoints.id]: [] }] },
        { [w.payment.id]: [{ [w.refund.id]: [w.refundApi.id] }] },
      ],
      stories: [{ [w.logs.id]: [w.logStore.id] }, { [w.emptyRoot.id]: [] }],
      tasks: [w.mail.id, w.percent.id],
    });
    expect(body.completed_count).toBe(1);
    // 絞らなければ、親に選べるストーリーは木から作れるので返さない
    expect(body.choices.stories).toBeNull();
    expect(body.choices.assignees.map((person) => person.id).sort()).toEqual(
      [w.target.leader.userId, w.target.member.userId].sort(),
    );
    expect(body.choices.assignees.every((person) => person.current)).toBe(true);
  });

  test('担当で絞ると、当たるタスクだけを親の下に出し、空の親を出さない。集計は全体の値のまま', async () => {
    const w = await world();
    // 完了したストーリーは、親に選べるストーリーに入れない
    await createStory(w.target.organization, w.target.workspace.id, w.target.admin.userId!, {
      title: '済んだ目標',
      position: 'a2',
      completed_at: AT,
      completed_by: w.target.admin.userId!,
    });
    const body = await treeBody(w.target, { assignee_user_id: w.target.leader.userId });
    expect(shape(body)).toEqual({
      epics: [{ [w.points.id]: [{ [w.memberScreen.id]: [w.pointsApi.id] }] }],
      stories: [{ [w.logs.id]: [w.logStore.id] }],
      tasks: [],
    });
    // 絞っているときは、親のない完了の件数を返さない
    expect(body.completed_count).toBeNull();
    // ストーリーとエピックの集計は、出していないタスク（画面の文言 2 pt）と完了（5 pt）も含む全体の値
    // 未完了の件数も、出していない行を含む（完了にできるかの判定に使う）
    expect(body.epics[0]!.stories[0]).toMatchObject({
      completed_task_count: 1,
      open_task_count: 2,
      points_done: 5,
      points_all: 10,
    });
    expect(body.epics[0]).toMatchObject({ points_done: 5, points_all: 10 });
    // エピックの選択肢は、絞って木から消えたエピックも含めて全部返す
    expect(body.choices.epics).toEqual([
      { id: w.points.id, title: '会員ポイント制度を公開する', finished: false },
      { id: w.payment.id, title: '決済まわりの障害を減らす', finished: false },
    ]);
    // 親に選べるストーリーも、絞って木から消えたものを含めて木の順で返す（起票と親を移すダイアログの候補）
    expect(body.choices.stories?.map((story) => [story.id, story.epic_id, story.category?.id ?? null])).toEqual([
      [w.memberScreen.id, w.points.id, w.upkeep.id],
      [w.emptyUnderPoints.id, w.points.id, w.upkeep.id],
      [w.refund.id, w.payment.id, null],
      [w.logs.id, null, w.extra.id],
      [w.emptyRoot.id, null, w.extra.id],
    ]);
  });

  test('担当の「自分」は呼んだ人、null は担当なし', async () => {
    const w = await world();
    const mine = await treeBody(w.target, { assignee_user_id: 'me' }, w.target.leader);
    expect(shape(mine)).toEqual(shape(await treeBody(w.target, { assignee_user_id: w.target.leader.userId })));
    const memberMine = await treeBody(w.target, { assignee_user_id: 'me' }, w.target.member);
    expect(shape(memberMine)).toEqual({
      epics: [{ [w.points.id]: [{ [w.memberScreen.id]: [w.wording.id] }] }],
      stories: [],
      tasks: [w.mail.id],
    });
    const nobody = await treeBody(w.target, { assignee_user_id: null });
    expect(shape(nobody)).toEqual({
      epics: [{ [w.payment.id]: [{ [w.refund.id]: [w.refundApi.id] }] }],
      stories: [],
      tasks: [w.percent.id],
    });
  });

  test('区分で絞ると、引き継ぎを解いた区分で当て、その区分の空のストーリーも出す。区分なしも選べる', async () => {
    const w = await world();
    const upkeep = await treeBody(w.target, { category_id: w.upkeep.id });
    expect(shape(upkeep)).toEqual({
      epics: [
        { [w.points.id]: [{ [w.memberScreen.id]: [w.pointsApi.id, w.wording.id] }, { [w.emptyUnderPoints.id]: [] }] },
      ],
      stories: [],
      tasks: [w.mail.id],
    });
    const extra = await treeBody(w.target, { category_id: w.extra.id });
    expect(shape(extra)).toEqual({
      epics: [],
      stories: [{ [w.logs.id]: [w.logStore.id] }, { [w.emptyRoot.id]: [] }],
      tasks: [],
    });
    const none = await treeBody(w.target, { category_id: null });
    expect(shape(none)).toEqual({
      epics: [{ [w.payment.id]: [{ [w.refund.id]: [w.refundApi.id] }] }],
      stories: [],
      tasks: [w.percent.id],
    });
  });

  test('区分と担当を組み合わせると「かつ」で当て、空のストーリーは出さない', async () => {
    const w = await world();
    const body = await treeBody(w.target, { category_id: w.upkeep.id, assignee_user_id: w.target.member.userId });
    expect(shape(body)).toEqual({
      epics: [{ [w.points.id]: [{ [w.memberScreen.id]: [w.wording.id] }] }],
      stories: [],
      tasks: [w.mail.id],
    });
  });

  test('リポジトリで絞る。リポジトリなしも選べる', async () => {
    const w = await world();
    const api = await treeBody(w.target, { repository_id: w.shopApi.id });
    expect(shape(api)).toEqual({
      epics: [{ [w.points.id]: [{ [w.memberScreen.id]: [w.pointsApi.id] }] }],
      stories: [],
      tasks: [w.mail.id],
    });
    const none = await treeBody(w.target, { repository_id: null });
    expect(shape(none)).toEqual({
      epics: [{ [w.points.id]: [{ [w.memberScreen.id]: [w.wording.id] }] }],
      stories: [{ [w.logs.id]: [w.logStore.id] }],
      tasks: [w.percent.id],
    });
  });

  test('エピックで絞ると、そのエピックの全部（空のストーリーも）を出す。エピックなしは親のないストーリーとタスクだけ', async () => {
    const w = await world();
    const points = await treeBody(w.target, { epic_id: w.points.id });
    expect(shape(points)).toEqual({
      epics: [
        { [w.points.id]: [{ [w.memberScreen.id]: [w.pointsApi.id, w.wording.id] }, { [w.emptyUnderPoints.id]: [] }] },
      ],
      stories: [],
      tasks: [],
    });
    const none = await treeBody(w.target, { epic_id: null });
    expect(shape(none)).toEqual({
      epics: [],
      stories: [{ [w.logs.id]: [w.logStore.id] }, { [w.emptyRoot.id]: [] }],
      tasks: [w.mail.id, w.percent.id],
    });
    // 中身の無いエピックも、そのエピックで絞れば出す
    const lonely = await createEpic(w.target.organization, w.target.workspace.id, w.target.admin.userId!, {
      title: '空のレイド',
      position: 'a2',
    });
    expect(shape(await treeBody(w.target, { epic_id: lonely.id }))).toEqual({
      epics: [{ [lonely.id]: [] }],
      stories: [],
      tasks: [],
    });
  });

  test('検索は空白（半角と全角）で分けた語をすべて含む行に当たり、英字の大文字と小文字を区別しない', async () => {
    const w = await world();
    const api = await treeBody(w.target, { query: '  api  ' });
    expect(shape(api)).toEqual({
      epics: [
        { [w.points.id]: [{ [w.memberScreen.id]: [w.pointsApi.id] }] },
        { [w.payment.id]: [{ [w.refund.id]: [w.refundApi.id] }] },
      ],
      stories: [],
      tasks: [],
    });
    const both = await treeBody(w.target, { query: '返金　API' });
    expect(shape(both)).toEqual({
      epics: [{ [w.payment.id]: [{ [w.refund.id]: [w.refundApi.id] }] }],
      stories: [],
      tasks: [],
    });
    // 語が親と子にまたがってそろっても当てない（「ポイント」はエピックと子のタスク、「返金」は別の枝）
    const across = await treeBody(w.target, { query: 'ポイント 文言' });
    expect(shape(across)).toEqual({ epics: [], stories: [], tasks: [] });
  });

  test('検索はストーリーとエピックの題にも当て、当たった親の配下を全部出す。担当でも絞ると、当たるタスクの無い親は出さない', async () => {
    const w = await world();
    // ストーリーの題に当たれば、配下のタスク（題に語を含まなくても）を出す
    const story = await treeBody(w.target, { query: 'を整える' });
    expect(shape(story)).toEqual({ epics: [], stories: [{ [w.logs.id]: [w.logStore.id] }], tasks: [] });
    // エピックの題に当たれば、配下のストーリーとタスクを全部出す（空のストーリーも）
    const epic = await treeBody(w.target, { query: '会員ポイント' });
    expect(shape(epic)).toEqual({
      epics: [
        { [w.points.id]: [{ [w.memberScreen.id]: [w.pointsApi.id, w.wording.id] }, { [w.emptyUnderPoints.id]: [] }] },
      ],
      stories: [],
      tasks: [],
    });
    const narrowed = await treeBody(w.target, { query: '会員ポイント', assignee_user_id: w.target.member.userId });
    expect(shape(narrowed)).toEqual({
      epics: [{ [w.points.id]: [{ [w.memberScreen.id]: [w.wording.id] }] }],
      stories: [],
      tasks: [],
    });
  });

  test('検索の %、_、\\ は普通の文字として探す', async () => {
    const w = await world();
    const backslash = await createTask(w.target.organization, w.target.workspace.id, w.target.admin.userId!, {
      title: 'C:\\temp の掃除',
      position: 'a3',
    });
    const only = (body: TreeBody) => ({ epics: body.epics.length, stories: body.stories.length, tasks: body.tasks });
    for (const query of ['%', '_', '0% 対応_']) {
      expect(only(await treeBody(w.target, { query })), query).toMatchObject({
        epics: 0,
        stories: 0,
        tasks: [{ id: w.percent.id }],
      });
    }
    expect(only(await treeBody(w.target, { query: '\\' }))).toMatchObject({ tasks: [{ id: backslash.id }] });
  });

  test('全角で 16 字を超える語でも探せる', async () => {
    const w = await world();
    const title = 'メンバー招待のメールが届かない件の調査と再送の手順の整理';
    const long = await createTask(w.target.organization, w.target.workspace.id, w.target.admin.userId!, {
      title,
      position: 'a3',
    });
    const body = await treeBody(w.target, { query: title });
    expect(body.tasks.map((task) => task.id)).toEqual([long.id]);
  });

  test('空白だけの検索は絞らない。長すぎる文字と、多すぎる語は 400', async () => {
    const w = await world();
    const blank = await treeBody(w.target, { query: ' 　 ' });
    expect(blank.completed_count).toBe(1);
    expect(blank.tasks).toHaveLength(2);
    const tooLong = await tree(w.target, { query: 'あ'.repeat(101) });
    expect(tooLong.status).toBe(400);
    expect(await errorCodeOf(tooLong)).toBe('invalid_input');
    const hundred = [...Array(4).fill('a'.repeat(20)), 'a'.repeat(16)].join(' ');
    expect([...hundred]).toHaveLength(100);
    expect((await tree(w.target, { query: hundred })).status).toBe(200);
    expect((await tree(w.target, { query: 'a b c d e f' })).status).toBe(400);
    // 1つの語の長さは、全体の上限のほかに限らない（D1 の LIKE の型の 50 バイトに縛られない）
    expect((await tree(w.target, { query: 'あ'.repeat(100) })).status).toBe(200);
    expect((await tree(w.target, { query: '%'.repeat(100) })).status).toBe(200);
    expect((await tree(w.target, { query: 'a b c d e' })).status).toBe(200);
  });

  test('削除した区分は、区分なしとして扱う', async () => {
    const w = await world();
    const gone = await createCategory(w.target.organization, w.target.workspace.id, {
      name: '廃止',
      position: 'a2',
      deleted_at: AT,
    });
    const orphan = await createTask(w.target.organization, w.target.workspace.id, w.target.admin.userId!, {
      title: '消えた区分のタスク',
      category_id: gone.id,
      position: 'a3',
    });
    expect((await treeBody(w.target, { category_id: gone.id })).tasks).toEqual([]);
    expect((await treeBody(w.target, { category_id: null })).tasks.map((task) => task.id)).toContain(orphan.id);
  });

  test('担当の選択肢には、離脱した人のうち未完了のバックログのタスクの担当に残っている人も出す', async () => {
    const w = await world();
    const { organization } = w.target;
    const workspaceId = w.target.workspace.id;
    const adminId = w.target.admin.userId!;
    const left = await createUser(organization, { name: '朝比奈 凪' });
    await createMembership(organization, workspaceId, left.id, { left_at: AT, left_on: '2026-10-10' });
    await createTask(organization, workspaceId, adminId, { title: '残った担当', assignee_user_id: left.id });
    // 離脱して、担当が完了したタスクか、別のワークスペースのタスクにだけ残っている人は出さない
    const finished = await createUser(organization, { name: '桐生 灯' });
    await createMembership(organization, workspaceId, finished.id, { left_at: AT, left_on: '2026-10-10' });
    await createTask(organization, workspaceId, adminId, {
      assignee_user_id: finished.id,
      completed_at: AT,
      completed_by: adminId,
    });
    await createTask(organization, w.target.otherWorkspace.id, adminId, { assignee_user_id: finished.id });

    const body = await treeBody(w.target);
    expect(
      body.choices.assignees
        .filter((person) => person.current)
        .map((person) => person.id)
        .sort(),
    ).toEqual([w.target.leader.userId, w.target.member.userId].sort());
    // 今所属している人の後に並べる
    expect(body.choices.assignees.at(-1)).toEqual({ id: left.id, name: '朝比奈 凪', current: false });
    expect(body.choices.assignees.map((person) => person.id)).not.toContain(finished.id);
    // 離脱した人でも絞れる
    expect((await treeBody(w.target, { assignee_user_id: left.id })).tasks.map((task) => task.title)).toEqual([
      '残った担当',
    ]);
  });
});

describe('実行計画', () => {
  test.each([
    ['絞らない', {}],
    ['担当', { assignee: 'u' }],
    ['担当なし', { assignee: null }],
    ['区分', { category: 'c' }],
    ['リポジトリ', { repository: 'r' }],
    ['エピック', { epic: 'e' }],
    ['検索', { words: ['請求'] }],
  ] as const)(
    'ストーリーの下の未完了のタスクは、絞り込み（%s）によらず tasks_story_open で引き、担当の索引をストーリーごとに引かない',
    async (_name, filter) => {
      const target = await createTarget();
      const db = orgDb(env, target.organization.verified);
      const plan = (
        await queryPlanForTest(env, openStoryTasksStatement(db, target.workspace.id, { words: [], ...filter }))
      ).join('\n');
      expect(plan).toContain('stories_workspace_epic');
      expect(plan).toMatch(/SEARCH tasks USING INDEX tasks_story_open \(story_id=\?\)/);
      expect(plan).not.toContain('tasks_assignee_user');
      expect(plan).not.toMatch(/^\s*SCAN tasks\b/m);
    },
  );
});

describe('backlog-tree の絞り込みと組織の分離', () => {
  test('別の組織と別のワークスペースの担当、区分、リポジトリ、エピックの ID は、何にも当たらない', async () => {
    const w = await world();
    const other = await createTarget();
    const otherAdmin = other.admin.userId!;
    const otherCategory = await createCategory(other.organization, other.workspace.id);
    const otherRepository = await createRepository(other.organization, other.workspace.id);
    const otherEpic = await createEpic(other.organization, other.workspace.id, otherAdmin);
    const otherStory = await createStory(other.organization, other.workspace.id, otherAdmin, {
      epic_id: otherEpic.id,
      category_id: null,
    });
    await createTask(other.organization, other.workspace.id, otherAdmin, {
      story_id: otherStory.id,
      assignee_user_id: other.member.userId,
      repository_id: otherRepository.id,
    });
    await createTask(other.organization, other.workspace.id, otherAdmin, {
      category_id: otherCategory.id,
      assignee_user_id: other.member.userId,
    });
    // 同じ組織の別のワークスペースの区分、リポジトリ、エピック
    const { organization } = w.target;
    const elsewhere = w.target.otherWorkspace.id;
    const elsewhereCategory = await createCategory(organization, elsewhere);
    const elsewhereRepository = await createRepository(organization, elsewhere);
    const elsewhereEpic = await createEpic(organization, elsewhere, w.target.admin.userId!);
    const elsewhereStory = await createStory(organization, elsewhere, w.target.admin.userId!, {
      epic_id: elsewhereEpic.id,
    });
    await createTask(organization, elsewhere, w.target.admin.userId!, {
      story_id: elsewhereStory.id,
      repository_id: elsewhereRepository.id,
      assignee_user_id: w.target.bystander.userId,
    });
    await createTask(organization, elsewhere, w.target.admin.userId!, { category_id: elsewhereCategory.id });

    const empty = { epics: [], stories: [], tasks: [] };
    for (const filter of [
      { assignee_user_id: other.member.userId },
      { category_id: otherCategory.id },
      { repository_id: otherRepository.id },
      { epic_id: otherEpic.id },
      { assignee_user_id: w.target.bystander.userId },
      { category_id: elsewhereCategory.id },
      { repository_id: elsewhereRepository.id },
      { epic_id: elsewhereEpic.id },
    ] satisfies Filter[]) {
      const body = await treeBody(w.target, filter);
      expect(shape(body), JSON.stringify(filter)).toEqual(empty);
      // 選択肢にも、別の組織と別のワークスペースの人は出ない
      expect(body.choices.assignees.map((person) => person.id)).not.toContain(other.member.userId);
      expect(body.choices.assignees.map((person) => person.id)).not.toContain(w.target.bystander.userId);
    }
    // 別の組織のワークスペースは、絞り込みを付けても 404
    const res = await post(app, backlogTree, {
      slug: w.target.slug,
      token: w.target.member.token,
      body: { workspace_id: other.workspace.id, category_id: otherCategory.id, query: 'api' },
    });
    expect(res.status).toBe(404);
  });
});
