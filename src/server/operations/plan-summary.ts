import { todayIn } from '../../shared/clock.ts';
import { planSummary, type VelocitySprint } from '../../shared/operations/sprint/index.ts';
import type { ExpressionBuilder, OrganizationTables } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { amountOf } from './experience.ts';
import { implement } from './implement.ts';
import { unfilledExists } from './task-field.ts';

// ベロシティの平均に入れる終了したスプリントの数と、平均から除いたことを示す延長したスプリントの最大数
const VELOCITY_COUNTED = 3;
const VELOCITY_EXCLUDED_MAX = 6;

type Row = {
  id: string;
  name: string | null;
  start_on: string;
  end_on: string;
  extended_days: number;
  points: unknown;
};

// 終了した（closed）削除していないスプリントの行と、その完了の記録のポイントの合計。
// 完了の記録は sprint_id で数え（始まる前に終えた仕事で膨らまない）、ワークスペースでも絞る。ポイントが空の記録は足さない
function pointsOf(eb: ExpressionBuilder<OrganizationTables, 'sprints'>, workspaceId: string) {
  return eb
    .selectFrom('completions')
    .select((inner) => inner.fn.coalesce(inner.fn.sum<number>('completions.points'), inner.lit(0)).as('total'))
    .whereRef('completions.sprint_id', '=', 'sprints.id')
    .where('completions.workspace_id', '=', workspaceId)
    .as('points');
}

function velocitySprintOf(row: Row, counted: boolean): VelocitySprint {
  return {
    id: row.id,
    name: row.name,
    start_on: row.start_on,
    end_on: row.end_on,
    extended_days: row.extended_days,
    points: amountOf(row.points),
    counted,
  };
}

// 計画の画面の集計を1回の batch() で読む（docs/data-model.md の sprints の plan-summary）。
// どの表もワークスペースで絞り、ワークスペースの行は組織でも絞る。エピックの残りは、バックログの木（task.ts の backlog-tree）の
// points_done と points_all と同じ数え方（配下のストーリーの、バックログの削除していないタスク）
export const planSummaryOperation = implement(planSummary, async ({ db, workspace }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const [workspaceResult, countedResult, extendedResult, lanesResult, epicsResult, epicTotalsResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['workspaces.timezone', 'workspaces.week_start'])
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId),
    ),
    // 平均に入れる、延長していない終了したスプリントの新しい 3 つ
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select((eb) => [
          'sprints.id',
          'sprints.name',
          'sprints.start_on',
          'sprints.end_on',
          'sprints.extended_days',
          pointsOf(eb, workspaceId),
        ])
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null)
        .where('sprints.status', '=', 'closed')
        .where('sprints.extended_days', '=', 0)
        .orderBy('sprints.start_on', 'desc')
        .orderBy('sprints.id', 'desc')
        .limit(VELOCITY_COUNTED),
    ),
    // 除いたことを示す、延長した終了したスプリント。3 つのうち最も古いものより後のものに絞るのは、読んだ後に行う
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select((eb) => [
          'sprints.id',
          'sprints.name',
          'sprints.start_on',
          'sprints.end_on',
          'sprints.extended_days',
          pointsOf(eb, workspaceId),
        ])
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null)
        .where('sprints.status', '=', 'closed')
        .where('sprints.extended_days', '>', 0)
        .orderBy('sprints.start_on', 'desc')
        .orderBy('sprints.id', 'desc')
        .limit(VELOCITY_EXCLUDED_MAX),
    ),
    // 先のスプリントごとの入れたポイント、件数、未見積もりの件数。タスクの無いスプリントも 0 で返す
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .leftJoin('tasks', (join) =>
          join
            .onRef('tasks.sprint_id', '=', 'sprints.id')
            .on('tasks.workspace_id', '=', workspaceId)
            .on('tasks.deleted_at', 'is', null),
        )
        .select((eb) => [
          'sprints.id',
          eb.fn.count<number>('tasks.id').as('task_count'),
          eb.fn.sum<number>(eb.fn.coalesce('tasks.points', eb.lit(0))).as('points'),
          eb.fn
            .sum<number>(
              eb
                .case()
                .when(
                  eb.and([
                    eb('tasks.id', 'is not', null),
                    eb('tasks.points', 'is', null),
                    eb('tasks.completed_at', 'is', null),
                  ]),
                )
                .then(1)
                .else(0)
                .end(),
            )
            .as('unestimated_count'),
          // 入っている完了していないタスクのうち、決まった欄が未記入のもの（削除していない欄に、値の行が無いものがある）
          eb.fn
            .sum<number>(
              eb
                .case()
                .when(
                  eb.and([
                    eb('tasks.id', 'is not', null),
                    eb('tasks.completed_at', 'is', null),
                    unfilledExists(eb, workspaceId),
                  ]),
                )
                .then(1)
                .else(0)
                .end(),
            )
            .as('unfilled_count'),
        ])
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null)
        .where('sprints.status', 'in', ['planned', 'active'])
        .groupBy('sprints.id')
        .orderBy('sprints.start_on')
        .orderBy('sprints.id'),
    ),
    // 削除していない、完了も中止もしていないエピック
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select(['epics.id', 'epics.title', 'epics.due_on'])
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null)
        .where('epics.completed_at', 'is', null)
        .where('epics.canceled_at', 'is', null)
        .orderBy('epics.position')
        .orderBy('epics.id'),
    ),
    // エピックごとの、配下のストーリーのタスクのポイント（完了した分と全体。未見積もりは 0）。
    // ストーリーから引いてタスクを結ぶ（backlog-tree と同じ形。タスクの story_id の索引にタスクの全件を探させない）
    db.statement((q) =>
      q
        .selectFrom('stories')
        .crossJoin('tasks')
        .whereRef('tasks.story_id', '=', 'stories.id')
        .whereRef('tasks.workspace_id', '=', 'stories.workspace_id')
        .select((eb) => [
          'stories.epic_id',
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
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null)
        .where('stories.epic_id', 'in', (eb) =>
          eb
            .selectFrom('epics')
            .select('epics.id')
            .where('epics.workspace_id', '=', workspaceId)
            .where('epics.deleted_at', 'is', null)
            .where('epics.completed_at', 'is', null)
            .where('epics.canceled_at', 'is', null),
        )
        .where('tasks.tray', '=', 'backlog')
        .where('tasks.deleted_at', 'is', null)
        .groupBy('stories.epic_id'),
    ),
  ] as const);

  const settings = workspaceResult.rows[0];
  if (settings === undefined) throw new ApiError(404, 'not_found');

  // 新しい 3 つ（新しい順に読んだ）。延長したスプリントは、そのうち最も古いものより後に始まったものだけを残す
  // （3 つに満たなければ、終了した延長のスプリントを全部。古い順に並べ直す）
  const counted = countedResult.rows;
  const oldestCounted = counted.length === VELOCITY_COUNTED ? counted[counted.length - 1]!.start_on : null;
  const excluded = extendedResult.rows.filter((row) => oldestCounted === null || row.start_on > oldestCounted);
  const sprints = [
    ...counted.map((row) => velocitySprintOf(row, true)),
    ...excluded.map((row) => velocitySprintOf(row, false)),
  ].sort((a, b) => (a.start_on === b.start_on ? (a.id < b.id ? -1 : 1) : a.start_on < b.start_on ? -1 : 1));
  const countedPoints = counted.map((row) => amountOf(row.points));

  const totals = new Map(epicTotalsResult.rows.map((row) => [row.epic_id!, row]));

  return {
    today: todayIn(settings.timezone),
    week_start: settings.week_start,
    velocity: {
      average: countedPoints.length === 0 ? null : countedPoints.reduce((a, b) => a + b, 0) / countedPoints.length,
      sprints,
    },
    lanes: lanesResult.rows.map((row) => ({
      sprint_id: row.id,
      points: amountOf(row.points),
      task_count: amountOf(row.task_count),
      unestimated_count: amountOf(row.unestimated_count),
      unfilled_count: amountOf(row.unfilled_count),
    })),
    epics: epicsResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      due_on: row.due_on,
      points_done: amountOf(totals.get(row.id)?.points_done),
      points_all: amountOf(totals.get(row.id)?.points_all),
    })),
  };
});
