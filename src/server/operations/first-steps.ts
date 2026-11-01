import type { z } from 'zod';
import {
  firstSteps,
  type FirstStep,
  type FirstStepKey,
  type FirstStepRole,
} from '../../shared/operations/organization/first-steps.ts';
import type { OrganizationTables, QueryCreator } from '../db/index.ts';
import { implement } from './implement.ts';

type WorkspaceRef = { id: string; name: string };

// 手順の並びと、必須かどうか。ロールごとに決まっている（docs/design.md の「最初にやること」）
const STEP_ORDER: Record<FirstStepRole, readonly { key: FirstStepKey; optional: boolean }[]> = {
  member: [
    { key: 'joined_workspace', optional: false },
    { key: 'prepare_task', optional: false },
    { key: 'mark_today', optional: true },
  ],
  leader: [
    { key: 'became_leader', optional: false },
    { key: 'invite_members', optional: false },
    { key: 'first_backlog_task', optional: false },
    { key: 'start_sprint', optional: true },
  ],
  admin: [
    { key: 'became_admin', optional: false },
    { key: 'create_workspace', optional: false },
    { key: 'invite_by_admin', optional: true },
    { key: 'register_holiday', optional: true },
  ],
};

// 出す手順が無いときの応答
const empty = { role: null, steps: [] } satisfies z.input<typeof firstSteps.output>;

// 自分が今リーダーの（閉じていない）ワークスペースのうち、条件を満たすものを返す文の共通の骨組み
function leaderWorkspaces(
  from: Pick<QueryCreator<OrganizationTables>, 'selectFrom'>,
  organizationId: string,
  userId: string,
) {
  return from
    .selectFrom('memberships as m')
    .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
    .where('m.user_id', '=', userId)
    .where('m.role', '=', 'leader')
    .where('m.left_at', 'is', null)
    .where('w.organization_id', '=', organizationId)
    .where('w.closed_at', 'is', null);
}

export const firstStepsOperation = implement(firstSteps, async ({ db, actor }) => {
  const userId = actor.userId;
  if (userId === null) return empty;

  // 共通の表は読まない。ワークスペース、招待、タスク、スプリント、所属、ユーザー、休日はどれも組織の中の表なので、
  // 組織で絞って組織の入口だけから読む。ロールを決める読み取りと、ロールの手順の済みを引く読み取りの2回に分ける
  const [membershipResult, anyWorkspaceResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['w.id as id', 'w.name as name', 'm.role as role'])
        .where('m.user_id', '=', userId)
        .where('m.left_at', 'is', null)
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .orderBy('w.name')
        .orderBy('w.id'),
    ),
    db.statement((q) =>
      q.selectFrom('workspaces').select('id').where('organization_id', '=', db.organizationId).limit(1),
    ),
  ] as const);

  const memberships = membershipResult.rows;
  const leaderOf: WorkspaceRef[] = memberships
    .filter((row) => row.role === 'leader')
    .map((row) => ({ id: row.id, name: row.name }));
  const firstJoined: WorkspaceRef | null =
    memberships.length > 0 ? { id: memberships[0]!.id, name: memberships[0]!.name } : null;

  let role: FirstStepRole | null = null;
  if (leaderOf.length > 0) role = 'leader';
  else if (memberships.length > 0) role = 'member';
  else if (actor.isAdmin && anyWorkspaceResult.rows.length === 0) role = 'admin';
  if (role === null) return empty;

  // 手順ごとの済みと、指すワークスペース
  const done = new Map<FirstStepKey, boolean>();
  const target = new Map<FirstStepKey, WorkspaceRef | null>();

  if (role === 'member') {
    const [createdResult, markedResult] = await db.batch([
      // 起票した（tasks.created_by）。削除したタスクも、起票したことは変わらないので数える。接続の登録は #67 が入るまで数えない
      db.statement((q) =>
        q
          .selectFrom('tasks as t')
          .innerJoin('workspaces as w', 'w.id', 't.workspace_id')
          .select('t.id')
          .where('t.created_by', '=', userId)
          .where('w.organization_id', '=', db.organizationId)
          .limit(1),
      ),
      db.statement((q) =>
        q
          .selectFrom('tasks as t')
          .innerJoin('workspaces as w', 'w.id', 't.workspace_id')
          .select('t.id')
          .where('t.assignee_user_id', '=', userId)
          .where('t.today_on', 'is not', null)
          .where('t.deleted_at', 'is', null)
          .where('w.organization_id', '=', db.organizationId)
          .limit(1),
      ),
    ] as const);
    done.set('joined_workspace', true);
    done.set('prepare_task', createdResult.rows.length > 0);
    done.set('mark_today', markedResult.rows.length > 0);
    for (const key of ['joined_workspace', 'prepare_task', 'mark_today'] as const) target.set(key, firstJoined);
  } else if (role === 'leader') {
    const [pendingResult, othersResult, backlogResult, sprintResult] = await db.batch([
      // 招待を出している（承諾待ちの招待がある）ワークスペース
      db.statement((q) =>
        leaderWorkspaces(q, db.organizationId, userId)
          .innerJoin('invitations as i', 'i.workspace_id', 'w.id')
          .select('w.id as workspace_id')
          .where('i.status', '=', 'pending')
          .distinct(),
      ),
      // 自分のほかに、今所属している人がいるワークスペース（招待を承諾して入った人）
      db.statement((q) =>
        leaderWorkspaces(q, db.organizationId, userId)
          .innerJoin('memberships as other', (join) =>
            join
              .onRef('other.workspace_id', '=', 'w.id')
              .onRef('other.user_id', '!=', 'm.user_id')
              .on('other.left_at', 'is', null),
          )
          .select('w.id as workspace_id')
          .distinct(),
      ),
      // バックログにタスクがあるワークスペース（受信箱とアーカイブは数えない）
      db.statement((q) =>
        leaderWorkspaces(q, db.organizationId, userId)
          .innerJoin('tasks as t', 't.workspace_id', 'w.id')
          .select('w.id as workspace_id')
          .where('t.tray', '=', 'backlog')
          .where('t.deleted_at', 'is', null)
          .distinct(),
      ),
      // 始めたことがある（進行中か終了した）スプリントがあるワークスペース
      db.statement((q) =>
        leaderWorkspaces(q, db.organizationId, userId)
          .innerJoin('sprints as s', 's.workspace_id', 'w.id')
          .select('w.id as workspace_id')
          .where('s.status', 'in', ['active', 'closed'])
          .where('s.deleted_at', 'is', null)
          .distinct(),
      ),
    ] as const);
    const satisfied = {
      invite_members: new Set([...pendingResult.rows, ...othersResult.rows].map((row) => row.workspace_id)),
      first_backlog_task: new Set(backlogResult.rows.map((row) => row.workspace_id)),
      start_sprint: new Set(sprintResult.rows.map((row) => row.workspace_id)),
    };
    // 複数のワークスペースのリーダーなら、どれか1つで済んでいれば済み。済んでいない手順は、どのワークスペースでも未完なので、
    // 名前順で先頭のワークスペースを指す
    for (const key of ['invite_members', 'first_backlog_task', 'start_sprint'] as const) {
      done.set(key, satisfied[key].size > 0);
      target.set(key, leaderOf[0]!);
    }
    done.set('became_leader', true);
    target.set('became_leader', leaderOf[0]!);
  } else {
    const [othersResult, holidayResult] = await db.batch([
      db.statement((q) =>
        q
          .selectFrom('users')
          .select('id')
          .where('organization_id', '=', db.organizationId)
          .where('id', '!=', userId)
          .where('disabled_at', 'is', null)
          .limit(1),
      ),
      db.statement((q) =>
        q
          .selectFrom('organization_holidays')
          .select('holiday_on')
          .where('organization_id', '=', db.organizationId)
          .limit(1),
      ),
    ] as const);
    done.set('became_admin', true);
    // このロールのときは組織にワークスペースが無いので、作る手順は未完。後から作られたらロールが変わる
    done.set('create_workspace', false);
    done.set('invite_by_admin', othersResult.rows.length > 0);
    done.set('register_holiday', holidayResult.rows.length > 0);
  }

  const steps: FirstStep[] = STEP_ORDER[role].map(({ key, optional }) => ({
    key,
    optional,
    done: done.get(key) ?? false,
    workspace: target.get(key) ?? null,
  }));
  // 必須の手順がすべて済んだら出さない。任意の手順は、済んでいなくても消す判定に使わない
  if (steps.every((step) => step.done || step.optional)) return empty;
  return { role, steps };
});
