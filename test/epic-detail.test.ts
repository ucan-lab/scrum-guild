// epic-detail（エピックの画面の読み取り）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { describe, expect, test } from 'vitest';
import { XP_EPIC_REWARD, levelOf } from '../src/shared/experience.ts';
import { epicDetail } from '../src/shared/operations/epic/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  AT,
  createCategory,
  createEpic,
  createEpicPartyMember,
  createMembership,
  createStory,
  createTask,
  createUser,
  createXpGrant,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Person_ = { id: string; name: string; left: boolean };
type DetailBody = {
  today: string;
  week_start: number;
  epic: {
    id: string;
    title: string;
    body_md: string | null;
    due_on: string | null;
    link_url: string | null;
    category: { id: string; name: string } | null;
    completed_at: string | null;
    canceled_at: string | null;
  };
  requester: Person_;
  reward_tier: string;
  reward_xp: number;
  party: (Person_ & { level: number; joined_via: string })[];
  stories: { id: string; title: string; completed_at: string | null; points_done: number; points_all: number }[];
  can_manage: boolean;
};

function detail(target: Target, epicId: string, person: Person = target.member) {
  return post(app, epicDetail, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId },
  });
}

async function read(target: Target, epicId: string, person: Person = target.member): Promise<DetailBody> {
  const res = await detail(target, epicId, person);
  expect(res.status).toBe(200);
  return (await res.json()) as DetailBody;
}

describe('epic-detail', () => {
  test('欄、依頼主、クリア報酬の段階と額を返し、討伐隊とストーリーが無ければ空で返す', async () => {
    const target = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id, { name: '営業' });
    const requester = await createUser(target.organization, { name: '青木 遥' });
    await createMembership(target.organization, target.workspace.id, requester.id);
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      title: '会員ポイント制度を公開する',
      body_md: '年内に公開する',
      due_on: '2026-12-20',
      link_url: 'https://example.com/epic',
      category_id: category.id,
      reward_tier: 'large',
      requester_user_id: requester.id,
    });

    const body = await read(target, epic.id);

    // 期日の印を決める、ワークスペースのタイムゾーンの今日と週の始まり
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.week_start).toBeGreaterThanOrEqual(0);
    expect(body.week_start).toBeLessThanOrEqual(6);
    expect(body.epic).toEqual({
      id: epic.id,
      title: '会員ポイント制度を公開する',
      body_md: '年内に公開する',
      due_on: '2026-12-20',
      link_url: 'https://example.com/epic',
      category: { id: category.id, name: '営業' },
      completed_at: null,
      canceled_at: null,
    });
    expect(body.requester).toEqual({ id: requester.id, name: '青木 遥', left: false });
    expect(body.reward_tier).toBe('large');
    expect(body.reward_xp).toBe(600);
    expect(body.party).toEqual([]);
    expect(body.stories).toEqual([]);
  });

  test('クリア報酬の額は、段階ごとに小 100、中 300、大 600', async () => {
    const target = await createTarget();
    const amounts: Record<string, number> = {};
    for (const tier of ['small', 'medium', 'large'] as const) {
      const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
        reward_tier: tier,
      });
      const body = await read(target, epic.id);
      expect(body.reward_tier).toBe(tier);
      amounts[tier] = body.reward_xp;
    }
    expect(amounts).toEqual({ small: 100, medium: 300, large: 600 });
    expect(XP_EPIC_REWARD).toEqual(amounts);
  });

  test('完了と中止の日時を返し、削除した区分は null にする', async () => {
    const target = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const cleared = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      category_id: category.id,
      completed_at: '2026-10-22T00:00:00.000Z',
      completed_by: target.admin.userId!,
    });
    const canceled = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      canceled_at: '2026-10-23T00:00:00.000Z',
      canceled_by: target.admin.userId!,
    });

    const clearedBody = await read(target, cleared.id);
    expect(clearedBody.epic.completed_at).toBe('2026-10-22T00:00:00.000Z');
    expect(clearedBody.epic.category).toBeNull();
    expect((await read(target, canceled.id)).epic.canceled_at).toBe('2026-10-23T00:00:00.000Z');
  });

  test('依頼主がワークスペースを離れていると left が真で、名前は出す。今所属していれば偽', async () => {
    const target = await createTarget();
    const gone = await createUser(target.organization, { name: '離れた 人' });
    await createMembership(target.organization, target.workspace.id, gone.id, { left_at: AT, left_on: '2026-10-20' });
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      requester_user_id: gone.id,
    });
    expect((await read(target, epic.id)).requester).toEqual({ id: gone.id, name: '離れた 人', left: true });

    // 抜けて戻った人は、今の所属の行があるので離脱済みにならない
    await createMembership(target.organization, target.workspace.id, gone.id);
    expect((await read(target, epic.id)).requester.left).toBe(false);

    // 別のワークスペースにだけ所属している人は、このワークスペースでは離脱済み
    const elsewhere = await createUser(target.organization, { name: '別の 人' });
    await createMembership(target.organization, target.otherWorkspace.id, elsewhere.id);
    const other = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      requester_user_id: elsewhere.id,
    });
    expect((await read(target, other.id)).requester.left).toBe(true);
  });

  test('討伐隊は入った順に、名前、離脱済みか、入り方、レベルを返す。経験値の数値は返さない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const otherEpic = await createEpic(target.organization, target.workspace.id, adminId);

    const veteran = await createUser(target.organization, { name: '古参 太郎' });
    await createMembership(target.organization, target.workspace.id, veteran.id);
    const newcomer = await createUser(target.organization, { name: '新人 花子' });
    await createMembership(target.organization, target.workspace.id, newcomer.id);
    const gone = await createUser(target.organization, { name: '離れた 人' });
    await createMembership(target.organization, target.workspace.id, gone.id, { left_at: AT, left_on: '2026-10-20' });

    // 組織の中の合計から出す。別のワークスペースで稼いだ分も含み、打ち消しも引く
    await createXpGrant(target.organization, target.workspace.id, veteran.id, { amount: 300 });
    await createXpGrant(target.organization, target.otherWorkspace.id, veteran.id, { amount: 250 });
    await createXpGrant(target.organization, target.workspace.id, veteran.id, { amount: -50 });
    await createXpGrant(target.organization, target.workspace.id, gone.id, { amount: 120 });

    await createEpicPartyMember(target.organization, epic.id, veteran.id, {
      joined_via: 'self',
      joined_at: '2026-10-20T00:00:00.000Z',
    });
    await createEpicPartyMember(target.organization, epic.id, newcomer.id, {
      joined_via: 'assigned',
      added_by: adminId,
      joined_at: '2026-10-21T00:00:00.000Z',
    });
    await createEpicPartyMember(target.organization, epic.id, gone.id, {
      joined_via: 'task_assignee',
      added_by: adminId,
      joined_at: '2026-10-22T00:00:00.000Z',
    });
    // ほかのエピックの討伐隊は混ざらない
    await createEpicPartyMember(target.organization, otherEpic.id, target.member.userId!);

    const body = await read(target, epic.id);

    expect(body.party).toEqual([
      { id: veteran.id, name: '古参 太郎', left: false, level: levelOf(500), joined_via: 'self' },
      { id: newcomer.id, name: '新人 花子', left: false, level: 1, joined_via: 'assigned' },
      { id: gone.id, name: '離れた 人', left: true, level: levelOf(120), joined_via: 'task_assignee' },
    ]);
    expect(body.party[0]!.level).toBe(3);
    // 数値は応答に入れない
    for (const member of body.party) {
      expect(Object.keys(member).sort()).toEqual(['id', 'joined_via', 'left', 'level', 'name']);
    }
    expect(JSON.stringify(body)).not.toMatch(/"(total|amount|xp)"/);
  });

  test('配下のストーリーを並びの順に返し、完了と、削除していないタスクのポイントの合計を数える', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const first = await createStory(target.organization, target.workspace.id, adminId, {
      epic_id: epic.id,
      title: '先のストーリー',
      position: 'a0',
    });
    const second = await createStory(target.organization, target.workspace.id, adminId, {
      epic_id: epic.id,
      title: '次のストーリー',
      position: 'a1',
      completed_at: '2026-10-22T00:00:00.000Z',
      completed_by: adminId,
    });
    const empty = await createStory(target.organization, target.workspace.id, adminId, {
      epic_id: epic.id,
      title: 'タスクの無いストーリー',
      position: 'a2',
    });
    // 数えないストーリー: 削除済み、別のエピック、親なし
    await createStory(target.organization, target.workspace.id, adminId, {
      epic_id: epic.id,
      position: 'a3',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const otherEpic = await createEpic(target.organization, target.workspace.id, adminId);
    await createStory(target.organization, target.workspace.id, adminId, { epic_id: otherEpic.id });
    await createStory(target.organization, target.workspace.id, adminId);

    const task = (storyId: string, overrides: Parameters<typeof createTask>[3]) =>
      createTask(target.organization, target.workspace.id, adminId, { story_id: storyId, ...overrides });
    await task(first.id, { points: 3 });
    await task(first.id, { points: 5, completed_at: '2026-10-22T00:00:00.000Z', completed_by: adminId });
    // 未見積もりは 0
    await task(first.id, { points: null });
    // 削除したタスクは数えない
    await task(first.id, { points: 8, deleted_at: '2026-10-22T00:00:00.000Z' });
    // アーカイブへ移したタスク（取り込んだタスクだけが移る）も数えない。アーカイブのタスクは tasks の CHECK で story_id を持てないので、
    // ストーリーを指す形は作れず、ここでは親なしのアーカイブのタスクが紛れ込まないことだけを確かめる
    await task(first.id, { points: 13, tray: 'archive', is_imported: 1, created_by: null, story_id: null });
    await task(second.id, { points: 2, completed_at: '2026-10-22T00:00:00.000Z', completed_by: adminId });
    await task(second.id, { points: 1, completed_at: '2026-10-22T00:00:00.000Z', completed_by: adminId });

    const body = await read(target, epic.id);

    expect(body.stories).toEqual([
      { id: first.id, title: '先のストーリー', completed_at: null, points_done: 5, points_all: 8 },
      {
        id: second.id,
        title: '次のストーリー',
        completed_at: '2026-10-22T00:00:00.000Z',
        points_done: 3,
        points_all: 3,
      },
      { id: empty.id, title: 'タスクの無いストーリー', completed_at: null, points_done: 0, points_all: 0 },
    ]);
  });

  test('別のワークスペースのタスクは、同じ ID のストーリーを指していても数えない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const story = await createStory(target.organization, target.workspace.id, adminId, { epic_id: epic.id });
    await createTask(target.organization, target.workspace.id, adminId, { story_id: story.id, points: 3 });
    // 行が壊れて別のワークスペースのタスクがストーリーを指していても、そのワークスペースの数に混ぜない
    await createTask(target.organization, target.otherWorkspace.id, adminId, { story_id: story.id, points: 8 });

    const body = await read(target, epic.id);
    expect(body.stories[0]!.points_all).toBe(3);
  });

  test('can_manage は、依頼主、リーダー、管理者で真、それ以外のメンバーで偽', async () => {
    const target = await createTarget();
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      requester_user_id: target.member.userId!,
    });
    const notRequested = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      requester_user_id: target.leader.userId!,
    });

    expect((await read(target, epic.id, target.member)).can_manage).toBe(true);
    expect((await read(target, epic.id, target.leader)).can_manage).toBe(true);
    expect((await read(target, epic.id, target.admin)).can_manage).toBe(true);
    expect((await read(target, notRequested.id, target.member)).can_manage).toBe(false);
  });

  test('閉じたワークスペースでも読める', async () => {
    const target = await createTarget({ closed: true });
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!);
    const res = await detail(target, epic.id, target.admin);
    expect(res.status).toBe(200);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const ids = [
      (await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createEpic(target.organization, target.otherWorkspace.id, adminId)).id,
      (await createEpic(target.organization, target.workspace.id, adminId, { deleted_at: '2026-10-21T00:00:00.000Z' }))
        .id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) {
      const res = await detail(target, id);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });

  test('別のワークスペースのエピックの討伐隊は、自分のワークスペースの ID では読めない', async () => {
    const target = await createTarget();
    const epic = await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!);
    await createEpicPartyMember(target.organization, epic.id, target.bystander.userId!);

    // 自分のワークスペースの ID で別のワークスペースのエピックを指しても、討伐隊の人の名前は漏れない
    const res = await detail(target, epic.id);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(target.bystander.userId!);
  });
});
