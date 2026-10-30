import { todayIn } from '../../shared/clock.ts';
import { XP_EPIC_REWARD, levelOf, type EpicRewardTier } from '../../shared/experience.ts';
import { epicDetail, type EpicJoinedVia } from '../../shared/operations/epic/index.ts';
import { ApiError } from '../errors.ts';
import { amountOf, epicPartyExperienceTotalsStatement } from './experience.ts';
import { implement } from './implement.ts';
import { activeMemberName, isLeaderOrAdmin } from './write-guards.ts';

// エピックの画面の読み取り（docs/data-model.md の epics の epic-detail）。読む表はどれも組織の中の表で、
// ワークスペースとエピックで絞る。人の名前は組織で絞った users から、離脱済みかは、そのワークスペースの今の所属
// （left_at が空の行は1人に1つ。task-edit の担当の判定と同じ）から読む。epic_party_members は workspace_id を持たないので、
// ワークスペースで絞ったエピックを結んで引く
export const epicDetailOperation = implement(epicDetail, async ({ db, actor, workspace, input }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  // users の行が無い人（型の上だけ）は、どの行にも当たらない空の ID で読む
  const actorUserId = actor.userId ?? '';

  const [epicResult, partyResult, storiesResult, totalsResult, settingsResult, joinableResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('epics')
        .innerJoin('users as requester', (join) =>
          join
            .onRef('requester.id', '=', 'epics.requester_user_id')
            .on('requester.organization_id', '=', organizationId),
        )
        .leftJoin('memberships as requester_membership', (join) =>
          join
            .onRef('requester_membership.user_id', '=', 'epics.requester_user_id')
            .on('requester_membership.workspace_id', '=', workspaceId)
            .on('requester_membership.left_at', 'is', null),
        )
        // 区分は、同じワークスペースの削除していないものだけを結ぶ（バックログの木と同じ）
        .leftJoin('categories', (join) =>
          join
            .onRef('categories.id', '=', 'epics.category_id')
            .on('categories.workspace_id', '=', workspaceId)
            .on('categories.deleted_at', 'is', null),
        )
        .select([
          'epics.id',
          'epics.title',
          'epics.body_md',
          'epics.due_on',
          'epics.link_url',
          'epics.completed_at',
          'epics.canceled_at',
          'epics.reward_tier',
          'epics.requester_user_id',
          'requester.name as requester_name',
          'requester_membership.id as requester_membership_id',
          'categories.id as category_ref_id',
          'categories.name as category_name',
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
    db.statement((q) =>
      q
        .selectFrom('epic_party_members as p')
        .innerJoin('epics as e', 'e.id', 'p.epic_id')
        .innerJoin('users as u', (join) =>
          join.onRef('u.id', '=', 'p.user_id').on('u.organization_id', '=', organizationId),
        )
        .leftJoin('memberships as m', (join) =>
          join.onRef('m.user_id', '=', 'p.user_id').on('m.workspace_id', '=', workspaceId).on('m.left_at', 'is', null),
        )
        .select(['u.id', 'u.name', 'p.joined_via', 'm.id as membership_id'])
        .where('p.epic_id', '=', epicId)
        .where('e.workspace_id', '=', workspaceId)
        .where('e.deleted_at', 'is', null)
        .orderBy('p.joined_at')
        .orderBy('p.user_id'),
    ),
    // ポイントの数え方は backlog-tree と同じ。削除していないバックログのタスクのポイントで、未見積もりは 0
    db.statement((q) =>
      q
        .selectFrom('stories')
        .leftJoin('tasks', (join) =>
          join
            .onRef('tasks.story_id', '=', 'stories.id')
            .onRef('tasks.workspace_id', '=', 'stories.workspace_id')
            .on('tasks.tray', '=', 'backlog')
            .on('tasks.deleted_at', 'is', null),
        )
        .select((eb) => [
          'stories.id',
          'stories.title',
          'stories.completed_at',
          eb.fn
            .sum<number>(
              eb
                .case()
                .when('tasks.completed_at', 'is not', null)
                .then(eb.fn.coalesce('tasks.points', eb.lit(0)))
                .else(0)
                .end(),
            )
            .as('points_done'),
          eb.fn.sum<number>(eb.fn.coalesce('tasks.points', eb.lit(0))).as('points_all'),
        ])
        .where('stories.epic_id', '=', epicId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null)
        .groupBy(['stories.id', 'stories.title', 'stories.completed_at', 'stories.position'])
        .orderBy('stories.position')
        .orderBy('stories.id'),
    ),
    epicPartyExperienceTotalsStatement(db, workspaceId, epicId),
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['workspaces.timezone', 'workspaces.week_start'])
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId),
    ),
    // 呼んだ人が討伐隊に入れる人か（受注の書く文と同じ条件）
    db.statement((q) => activeMemberName(q, organizationId, workspaceId, actorUserId)),
  ] as const);

  const epic = epicResult.rows[0];
  const settings = settingsResult.rows[0];
  if (epic === undefined || settings === undefined) throw new ApiError(404, 'not_found');

  const totals = new Map(totalsResult.rows.map((row) => [row.user_id, amountOf(row.total)]));
  // reward_tier と joined_via は列の CHECK が守る値。列挙に無い値が来ても、出力のスキーマ（z.enum）が 500 で止める
  const rewardTier = epic.reward_tier as EpicRewardTier;
  return {
    today: todayIn(settings.timezone),
    week_start: settings.week_start,
    epic: {
      id: epic.id,
      title: epic.title,
      body_md: epic.body_md,
      due_on: epic.due_on,
      link_url: epic.link_url,
      category:
        epic.category_ref_id === null || epic.category_name === null
          ? null
          : { id: epic.category_ref_id, name: epic.category_name },
      completed_at: epic.completed_at,
      canceled_at: epic.canceled_at,
    },
    requester: {
      id: epic.requester_user_id,
      name: epic.requester_name,
      left: epic.requester_membership_id === null,
    },
    reward_tier: rewardTier,
    reward_xp: XP_EPIC_REWARD[rewardTier],
    party: partyResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      left: row.membership_id === null,
      level: levelOf(totals.get(row.id) ?? 0),
      joined_via: row.joined_via as EpicJoinedVia,
    })),
    stories: storiesResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      completed_at: row.completed_at,
      points_done: amountOf(row.points_done),
      points_all: amountOf(row.points_all),
    })),
    can_manage: (actor.userId !== null && actor.userId === epic.requester_user_id) || isLeaderOrAdmin(actor, workspace),
    can_change_requester: isLeaderOrAdmin(actor, workspace),
    can_join: joinableResult.rows.length > 0,
    joined: partyResult.rows.some((row) => row.id === actorUserId),
  };
});
