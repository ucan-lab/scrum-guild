// 経験値とレベルの読み取り（experience-summary、experience-grants、experience-team-total と、member-list と organization のレベル）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { describe, expect, test } from 'vitest';
import {
  EXPERIENCE_GRANTS_PAGE_SIZE,
  experienceGrants,
  experienceSummary,
  experienceTeamTotal,
} from '../src/shared/operations/experience/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { memberList } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createEpic,
  createMembership,
  createOrganization,
  createStory,
  createTask,
  createThanks,
  createWorkspace,
  createXpGrant,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

async function call<T>(
  definition: Parameters<typeof post>[1],
  target: Target,
  person: Person,
  body: unknown = {},
): Promise<T> {
  const res = await post(app, definition, { slug: target.slug, token: person.token, body });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

// 応答の中の数と文字列をすべて集める（ほかの人の値が、どの項目にも入っていないことを見る）
function valuesIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(valuesIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(valuesIn);
  return [value];
}
const numbersIn = (value: unknown) => valuesIn(value).filter((item) => typeof item === 'number');
const stringsIn = (value: unknown) => valuesIn(value).filter((item) => typeof item === 'string');

type Summary = {
  total: number;
  level: number;
  level_start: number;
  next_level_at: number;
  prospective: number;
  thanks_received: number;
  workspaces: { id: string; name: string; total: number; prospective: number; thanks_received: number }[];
};

type Grants = {
  grants: {
    id: string;
    confirmed_at: string;
    workspace_id: string;
    workspace_name: string;
    action: string;
    content: string | null;
    content_hidden: boolean;
    amount: number;
  }[];
  next: { confirmed_at: string; id: string } | null;
};

describe('experience-summary', () => {
  test('組織の合計は2つのワークスペースの合計で、レベルは両方の合計から出る。内訳は名前の順', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    // 2つ目のワークスペース（名前が先に来る）にも所属させる
    const second = await createWorkspace(target.organization, target.admin.userId!, { name: 'あさひ班' });
    await createMembership(target.organization, second.id, memberId);
    await createXpGrant(target.organization, target.workspace.id, memberId, { amount: 60 });
    await createXpGrant(target.organization, second.id, memberId, { amount: 50 });

    const summary = await call<Summary>(experienceSummary, target, target.member);
    // どちらか一方だけではレベル1のまま。合計 110 でレベル2
    expect(summary).toEqual({
      total: 110,
      level: 2,
      level_start: 100,
      next_level_at: 300,
      prospective: 0,
      thanks_received: 0,
      workspaces: [
        { id: second.id, name: 'あさひ班', total: 50, prospective: 0, thanks_received: 0 },
        { id: target.workspace.id, name: '青葉チーム', total: 60, prospective: 0, thanks_received: 0 },
      ],
    });
  });

  test('打ち消しで合計が 0 を下回っても、レベルは1のまま', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const grant = await createXpGrant(target.organization, target.workspace.id, memberId, {
      action: 'task_completed',
      amount: 30,
    });
    await createXpGrant(target.organization, target.workspace.id, memberId, {
      action: 'task_completed',
      amount: -30,
      reverses_grant_id: grant.id,
    });
    await createXpGrant(target.organization, target.workspace.id, memberId, { action: 'story_completed', amount: -20 });

    const summary = await call<Summary>(experienceSummary, target, target.member);
    expect(summary).toMatchObject({ total: -20, level: 1, level_start: 0, next_level_at: 100 });
  });

  test('抜けたワークスペースと閉じたワークスペースの明細も合計に入り、明細も所属も無いワークスペースは出ない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const left = await createWorkspace(target.organization, target.admin.userId!, { name: 'い班' });
    await createMembership(target.organization, left.id, memberId, {
      left_at: '2026-10-21T00:00:00.000Z',
      left_on: '2026-10-21',
    });
    await createXpGrant(target.organization, left.id, memberId, { amount: 40 });
    // 閉じたワークスペースに今所属している（明細は無い）
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      name: 'う班',
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    await createMembership(target.organization, closed.id, memberId);

    const summary = await call<Summary>(experienceSummary, target, target.member);
    expect(summary.total).toBe(40);
    expect(summary.workspaces).toEqual([
      { id: left.id, name: 'い班', total: 40, prospective: 0, thanks_received: 0 },
      { id: closed.id, name: 'う班', total: 0, prospective: 0, thanks_received: 0 },
      { id: target.workspace.id, name: '青葉チーム', total: 0, prospective: 0, thanks_received: 0 },
    ]);
    // 明細も今の所属も無いワークスペース（otherWorkspace）は出さない
    expect(summary.workspaces.map((workspace) => workspace.id)).not.toContain(target.otherWorkspace.id);
  });

  test('見込みは、今所属している閉じていないワークスペースの、自分が手で作った未完了のポイント1以上のタスク1件につき起票の経験値', async () => {
    const target = await createTarget();
    const organization = target.organization;
    const memberId = target.member.userId!;
    const workspaceId = target.workspace.id;
    // 数えるもの: 2件
    await createTask(organization, workspaceId, memberId, { points: 1 });
    await createTask(organization, workspaceId, memberId, { points: 13 });
    // 数えないもの
    await createTask(organization, workspaceId, memberId, { points: null });
    await createTask(organization, workspaceId, memberId, { points: 0 });
    await createTask(organization, workspaceId, memberId, {
      points: 3,
      completed_at: '2026-10-21T00:00:00.000Z',
      completed_by: memberId,
    });
    await createTask(organization, workspaceId, memberId, { points: 3, deleted_at: '2026-10-21T00:00:00.000Z' });
    await createTask(organization, workspaceId, memberId, {
      points: 3,
      is_imported: 1,
      tray: 'inbox',
    });
    await createTask(organization, workspaceId, target.leader.userId!, { points: 3 });
    // 閉じたワークスペースと、抜けたワークスペースのタスク
    const closed = await createWorkspace(organization, target.admin.userId!, {
      name: 'う班',
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    await createMembership(organization, closed.id, memberId);
    await createTask(organization, closed.id, memberId, { points: 3 });
    const left = await createWorkspace(organization, target.admin.userId!, { name: 'い班' });
    await createMembership(organization, left.id, memberId, {
      left_at: '2026-10-21T00:00:00.000Z',
      left_on: '2026-10-21',
    });
    await createTask(organization, left.id, memberId, { points: 3 });

    const summary = await call<Summary>(experienceSummary, target, target.member);
    expect(summary.prospective).toBe(20);
    expect(summary.total).toBe(0);
    expect(summary.workspaces).toEqual([
      { id: closed.id, name: 'う班', total: 0, prospective: 0, thanks_received: 0 },
      { id: workspaceId, name: '青葉チーム', total: 0, prospective: 20, thanks_received: 0 },
    ]);
  });

  test('ほかの人の明細と、別の組織のワークスペースを指す明細は数えない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    await createXpGrant(target.organization, target.workspace.id, memberId, { amount: 30 });
    await createXpGrant(target.organization, target.workspace.id, target.leader.userId!, { amount: 900 });
    // 別の組織のワークスペースに、この人の ID で書かれた壊れた行
    const other = await createTarget();
    await createXpGrant(other.organization, other.workspace.id, memberId, { amount: 500 });

    const summary = await call<Summary>(experienceSummary, target, target.member);
    expect(summary.total).toBe(30);
    expect(summary.workspaces.map((workspace) => workspace.id)).toEqual([target.workspace.id]);
  });

  test('所属していない管理者は、明細が無ければ合計 0、内訳は空', async () => {
    const target = await createTarget();
    expect(await call<Summary>(experienceSummary, target, target.admin)).toEqual({
      total: 0,
      level: 1,
      level_start: 0,
      next_level_at: 100,
      prospective: 0,
      thanks_received: 0,
      workspaces: [],
    });
  });

  test('受け取った感謝の数は、呼んだ人が受け取った分だけをワークスペースごとと合計で返し、送った分とほかの人の分は数えない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const leaderId = target.leader.userId!;
    const second = await createWorkspace(target.organization, target.admin.userId!, { name: 'あさひ班' });
    await createMembership(target.organization, second.id, memberId);
    await createMembership(target.organization, second.id, leaderId);
    const send = async (workspaceId: string, from: string, to: string) => {
      const task = await createTask(target.organization, workspaceId, from);
      await createThanks(target.organization, workspaceId, task.id, from, to);
    };
    // メンバーが受け取った: 青葉チームで2件、あさひ班で1件
    await send(target.workspace.id, leaderId, memberId);
    await send(target.workspace.id, leaderId, memberId);
    await send(second.id, leaderId, memberId);
    // メンバーが送った分と、ほかの人が受け取った分
    await send(target.workspace.id, memberId, leaderId);
    await send(second.id, memberId, leaderId);

    const summary = await call<Summary>(experienceSummary, target, target.member);
    expect(summary.thanks_received).toBe(3);
    expect(summary.workspaces).toEqual([
      { id: second.id, name: 'あさひ班', total: 0, prospective: 0, thanks_received: 1 },
      { id: target.workspace.id, name: '青葉チーム', total: 0, prospective: 0, thanks_received: 2 },
    ]);
    // リーダーの応答は、リーダーが受け取った2件だけ
    expect((await call<Summary>(experienceSummary, target, target.leader)).thanks_received).toBe(2);
    // 感謝を送っただけの人は 0
    expect((await call<Summary>(experienceSummary, target, target.admin)).thanks_received).toBe(0);
  });

  test('今所属していないワークスペースで受け取った感謝も数え、そのワークスペースを内訳に出す。別の組織の感謝は数えない', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const left = await createWorkspace(target.organization, target.admin.userId!, { name: 'い班' });
    await createMembership(target.organization, left.id, memberId, {
      left_at: '2026-10-21T00:00:00.000Z',
      left_on: '2026-10-21',
    });
    const task = await createTask(target.organization, left.id, target.leader.userId!);
    await createThanks(target.organization, left.id, task.id, target.leader.userId!, memberId);
    // 別の組織の感謝（この人の ID で書かれた壊れた行）は数えない
    const other = await createTarget();
    const otherTask = await createTask(other.organization, other.workspace.id, other.leader.userId!);
    await createThanks(other.organization, other.workspace.id, otherTask.id, other.leader.userId!, memberId);

    const summary = await call<Summary>(experienceSummary, target, target.member);
    expect(summary.thanks_received).toBe(1);
    expect(summary.workspaces.find((workspace) => workspace.id === left.id)).toEqual({
      id: left.id,
      name: 'い班',
      total: 0,
      prospective: 0,
      thanks_received: 1,
    });
  });

  test('削除したタスクの感謝も数える。感謝だけがあるワークスペースも、名前つきで内訳に出る', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const leaderId = target.leader.userId!;
    const task = await createTask(target.organization, target.workspace.id, leaderId);
    await createThanks(target.organization, target.workspace.id, task.id, leaderId, memberId);
    const deleted = await createTask(target.organization, target.workspace.id, leaderId, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createThanks(target.organization, target.workspace.id, deleted.id, leaderId, memberId);
    // 所属も明細も無いワークスペースの、削除したタスクの感謝
    const gone = await createWorkspace(target.organization, target.admin.userId!, { name: 'え班' });
    const goneTask = await createTask(target.organization, gone.id, leaderId, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createThanks(target.organization, gone.id, goneTask.id, leaderId, memberId);

    const summary = await call<Summary>(experienceSummary, target, target.member);
    expect(summary.thanks_received).toBe(3);
    expect(summary.workspaces).toEqual([
      { id: gone.id, name: 'え班', total: 0, prospective: 0, thanks_received: 1 },
      { id: target.workspace.id, name: '青葉チーム', total: 0, prospective: 0, thanks_received: 2 },
    ]);
  });

  test('ほかの人の応答に、受け取った感謝の数を載せない（本人の応答にだけある）', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    await createThanks(target.organization, target.workspace.id, task.id, target.leader.userId!, target.member.userId!);
    // メンバー一覧と組織の応答は、レベルだけを返し、感謝の数も経験値も含まない
    const members = await call<unknown>(memberList, target, target.leader, { workspace_id: target.workspace.id });
    const organization = await call<unknown>(organizationInfo, target, target.leader);
    for (const response of [members, organization]) {
      expect(JSON.stringify(response)).not.toContain('thanks_received');
    }
  });
});

describe('experience-grants', () => {
  test('呼んだ人の明細を新しい順に返し、内容はタスク、ストーリー、エピックのタイトル（削除したものも）', async () => {
    const target = await createTarget();
    const organization = target.organization;
    const memberId = target.member.userId!;
    const workspaceId = target.workspace.id;
    const task = await createTask(organization, workspaceId, memberId, {
      title: '請求書の様式を直す',
      deleted_at: '2026-10-23T00:00:00.000Z',
    });
    const story = await createStory(organization, workspaceId, memberId, { title: '請求をまとめて出せる' });
    const epic = await createEpic(organization, workspaceId, memberId, { title: '月末の締めを早める' });
    const created = await createXpGrant(organization, workspaceId, memberId, {
      task_id: task.id,
      confirmed_at: '2026-10-21T00:00:00.000Z',
    });
    const reversal = await createXpGrant(organization, workspaceId, memberId, {
      task_id: task.id,
      amount: -10,
      reverses_grant_id: created.id,
      confirmed_at: '2026-10-22T00:00:00.000Z',
    });
    const storyGrant = await createXpGrant(organization, workspaceId, memberId, {
      action: 'story_completed',
      story_id: story.id,
      amount: 20,
      confirmed_at: '2026-10-23T00:00:00.000Z',
    });
    const epicGrant = await createXpGrant(organization, workspaceId, memberId, {
      action: 'epic_reward',
      epic_id: epic.id,
      amount: 100,
      confirmed_at: '2026-10-24T00:00:00.000Z',
    });
    // ほかの人の明細は出ない
    await createXpGrant(organization, workspaceId, target.leader.userId!, { confirmed_at: '2026-10-25T00:00:00.000Z' });

    const listed = await call<Grants>(experienceGrants, target, target.member);
    expect(listed.next).toBeNull();
    const common = { workspace_id: workspaceId, workspace_name: '青葉チーム', content_hidden: false };
    expect(listed.grants).toEqual([
      {
        ...common,
        id: epicGrant.id,
        confirmed_at: epicGrant.confirmed_at,
        action: 'epic_reward',
        content: '月末の締めを早める',
        amount: 100,
      },
      {
        ...common,
        id: storyGrant.id,
        confirmed_at: storyGrant.confirmed_at,
        action: 'story_completed',
        content: '請求をまとめて出せる',
        amount: 20,
      },
      {
        ...common,
        id: reversal.id,
        confirmed_at: reversal.confirmed_at,
        action: 'task_created',
        content: '請求書の様式を直す',
        amount: -10,
      },
      {
        ...common,
        id: created.id,
        confirmed_at: created.confirmed_at,
        action: 'task_created',
        content: '請求書の様式を直す',
        amount: 10,
      },
    ]);
  });

  test('50 件ずつ返し、next を before に渡すと続きを読む。同じ確定日時は id の降順', async () => {
    const target = await createTarget();
    const memberId = target.member.userId!;
    const ids: string[] = [];
    for (let index = 0; index < EXPERIENCE_GRANTS_PAGE_SIZE + 2; index++) {
      const grant = await createXpGrant(target.organization, target.workspace.id, memberId, {
        confirmed_at: '2026-10-21T00:00:00.000Z',
      });
      ids.push(grant.id);
    }
    const expected = [...ids].sort().reverse();

    const first = await call<Grants>(experienceGrants, target, target.member);
    expect(first.grants.map((grant) => grant.id)).toEqual(expected.slice(0, EXPERIENCE_GRANTS_PAGE_SIZE));
    expect(first.next).toEqual({
      confirmed_at: '2026-10-21T00:00:00.000Z',
      id: expected[EXPERIENCE_GRANTS_PAGE_SIZE - 1],
    });

    const second = await call<Grants>(experienceGrants, target, target.member, { before: first.next });
    expect(second.grants.map((grant) => grant.id)).toEqual(expected.slice(EXPERIENCE_GRANTS_PAGE_SIZE));
    expect(second.next).toBeNull();
  });

  test('ちょうど 50 件なら next は null', async () => {
    const target = await createTarget();
    for (let index = 0; index < EXPERIENCE_GRANTS_PAGE_SIZE; index++) {
      await createXpGrant(target.organization, target.workspace.id, target.member.userId!);
    }
    const listed = await call<Grants>(experienceGrants, target, target.member);
    expect(listed.grants).toHaveLength(EXPERIENCE_GRANTS_PAGE_SIZE);
    expect(listed.next).toBeNull();
  });

  test('今所属していないワークスペースの行は、名前と値は出し、内容（タイトル）は伏せる', async () => {
    const target = await createTarget();
    const organization = target.organization;
    const memberId = target.member.userId!;
    // 抜けたワークスペース
    const left = await createWorkspace(organization, target.admin.userId!, { name: 'い班' });
    await createMembership(organization, left.id, memberId, {
      left_at: '2026-10-21T00:00:00.000Z',
      left_on: '2026-10-21',
    });
    const leftTask = await createTask(organization, left.id, memberId, { title: '抜けた後に書き換えた題' });
    await createXpGrant(organization, left.id, memberId, {
      task_id: leftTask.id,
      amount: 30,
      confirmed_at: '2026-10-20T00:00:00.000Z',
    });
    // 今所属しているワークスペースの行は内容を出す
    const task = await createTask(organization, target.workspace.id, memberId, { title: '請求書の様式を直す' });
    await createXpGrant(organization, target.workspace.id, memberId, {
      task_id: task.id,
      confirmed_at: '2026-10-22T00:00:00.000Z',
    });

    const listed = await call<Grants>(experienceGrants, target, target.member);
    expect(
      listed.grants.map(({ workspace_name, content, content_hidden, amount }) => ({
        workspace_name,
        content,
        content_hidden,
        amount,
      })),
    ).toEqual([
      { workspace_name: '青葉チーム', content: '請求書の様式を直す', content_hidden: false, amount: 10 },
      { workspace_name: 'い班', content: null, content_hidden: true, amount: 30 },
    ]);
    expect(stringsIn(listed)).not.toContain('抜けた後に書き換えた題');
  });

  test('所属していない管理者の明細（所属を外れたワークスペースの行）も、内容を伏せる', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      title: '見せない題',
    });
    await createXpGrant(target.organization, target.workspace.id, target.admin.userId!, { task_id: task.id });
    const listed = await call<Grants>(experienceGrants, target, target.admin);
    expect(listed.grants).toHaveLength(1);
    expect(listed.grants[0]).toMatchObject({ content: null, content_hidden: true, workspace_name: '青葉チーム' });
  });

  test('別の組織のワークスペースを指す行は出ない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    await createXpGrant(other.organization, other.workspace.id, target.member.userId!);
    expect((await call<Grants>(experienceGrants, target, target.member)).grants).toEqual([]);
  });

  test.each([
    [{ confirmed_at: '2026-10-21', id: 'x' }],
    [{ confirmed_at: '2026-10-21T00:00:00Z', id: 'x' }],
    [{ confirmed_at: '2026-10-21T00:00:00.000Z' }],
    ['2026-10-21T00:00:00.000Z'],
  ])('形の違うカーソル %j は 400', async (before) => {
    const target = await createTarget();
    const res = await post(app, experienceGrants, {
      slug: target.slug,
      token: target.member.token,
      body: { before },
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });
});

describe('experience-team-total', () => {
  test('そのワークスペースの全員の明細の合計（抜けた人の分も含む）を、1つの数だけで返す', async () => {
    const target = await createTarget();
    const organization = target.organization;
    const workspaceId = target.workspace.id;
    await createXpGrant(organization, workspaceId, target.member.userId!, { amount: 40 });
    await createXpGrant(organization, workspaceId, target.leader.userId!, { amount: 70 });
    await createXpGrant(organization, workspaceId, target.leader.userId!, { amount: -10 });
    // 抜けた人の分も含む
    const leftPerson = await createPerson({ organization });
    await createMembership(organization, workspaceId, leftPerson.userId!, {
      left_at: '2026-10-21T00:00:00.000Z',
      left_on: '2026-10-21',
    });
    await createXpGrant(organization, workspaceId, leftPerson.userId!, { amount: 5 });
    // ほかのワークスペースの明細は入らない
    await createXpGrant(organization, target.otherWorkspace.id, target.bystander.userId!, { amount: 999 });

    for (const person of [target.member, target.leader, target.admin]) {
      const result = await call<Record<string, unknown>>(experienceTeamTotal, target, person, {
        workspace_id: workspaceId,
      });
      expect(result).toEqual({ total: 105 });
    }
  });

  test('明細が無ければ 0', async () => {
    const target = await createTarget();
    expect(
      await call<{ total: number }>(experienceTeamTotal, target, target.member, { workspace_id: target.workspace.id }),
    ).toEqual({ total: 0 });
  });
});

describe('レベル（member-list と organization）', () => {
  test('メンバーの一覧の各行にレベル。2つのワークスペースの合計から出し、経験値の数値は返さない', async () => {
    const target = await createTarget();
    const organization = target.organization;
    const leaderId = target.leader.userId!;
    // リーダーは2つのワークスペースで得た。それぞれではレベル2、合計 12345 でレベル16
    const second = await createWorkspace(organization, target.admin.userId!, { name: 'あさひ班' });
    await createMembership(organization, second.id, leaderId);
    await createXpGrant(organization, target.workspace.id, leaderId, { amount: 6000 });
    await createXpGrant(organization, second.id, leaderId, { amount: 6345 });
    // メンバーは打ち消しで負
    await createXpGrant(organization, target.workspace.id, target.member.userId!, { amount: -40 });

    const res = await post(app, memberList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const listed = JSON.parse(text) as { members: { id: string; level: number }[] };
    expect(Object.fromEntries(listed.members.map((member) => [member.id, member.level]))).toEqual({
      [leaderId]: 16,
      [target.member.userId!]: 1,
    });
    // ほかの人の合計とワークスペースごとの値は、応答のどこにも出ない
    const numbers = numbersIn(listed);
    for (const value of [12345, 6000, 6345, -40]) expect(numbers).not.toContain(value);
    for (const member of listed.members) {
      expect(Object.keys(member).sort()).toEqual(['avatar_url', 'id', 'joined_on', 'level', 'name', 'role']);
    }
  });

  test('メンバーの一覧のレベルは、別の組織のワークスペースを指す明細を数えない', async () => {
    const target = await createTarget();
    const leaderId = target.leader.userId!;
    await createXpGrant(target.organization, target.workspace.id, leaderId, { amount: 50 });
    // 別の組織のワークスペースに、リーダーの ID で書かれた壊れた行。数えるとレベル3（50 + 500 = 550）になる
    const other = await createTarget();
    await createXpGrant(other.organization, other.workspace.id, leaderId, { amount: 500 });

    const res = await post(app, memberList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as { members: { id: string; level: number }[] };
    expect(listed.members.find((member) => member.id === leaderId)?.level).toBe(1);
  });

  test('組織の枠の me に自分のレベル。数値と、ほかの人の値は返さない', async () => {
    const target = await createTarget();
    const organization = target.organization;
    await createXpGrant(organization, target.workspace.id, target.member.userId!, { amount: 70 });
    await createXpGrant(organization, target.workspace.id, target.member.userId!, { amount: 250 });
    await createXpGrant(organization, target.workspace.id, target.leader.userId!, { amount: 98765 });
    // 別の組織の同じアカウントの明細は数えない（レベルは組織ごとに1つ）
    const elsewhere = await createOrganization();
    const elsewhereWorkspace = await createWorkspace(elsewhere, target.admin.userId!);
    await createXpGrant(elsewhere, elsewhereWorkspace.id, target.member.userId!, { amount: 5000 });

    const res = await post(app, organizationInfo, { slug: target.slug, token: target.member.token });
    expect(res.status).toBe(200);
    const info = (await res.json()) as { me: Record<string, unknown> };
    expect(info.me.level).toBe(3);
    expect(Object.keys(info.me).sort()).toEqual(['id', 'is_admin', 'level', 'name', 'theme']);
    const numbers = numbersIn(info);
    for (const value of [70, 250, 320, 98765, 5000]) expect(numbers).not.toContain(value);
  });

  test('経験値の読み取りの応答に、ほかの人の数値と明細が出ない', async () => {
    const target = await createTarget();
    const organization = target.organization;
    await createXpGrant(organization, target.workspace.id, target.member.userId!, { amount: 30 });
    const leaderGrant = await createXpGrant(organization, target.workspace.id, target.leader.userId!, {
      amount: 4321,
    });

    const summary = await call<Summary>(experienceSummary, target, target.member);
    const grants = await call<Grants>(experienceGrants, target, target.member);
    for (const body of [summary, grants]) {
      expect(numbersIn(body)).not.toContain(4321);
      expect(stringsIn(body)).not.toContain(leaderGrant.id);
      expect(stringsIn(body)).not.toContain(target.leader.userId!);
    }
    expect(summary.total).toBe(30);
    expect(grants.grants.map((grant) => grant.amount)).toEqual([30]);
  });
});
