import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { sprintRefSchema } from './sprint.ts';

// ベロシティの元になる、終了したスプリント1つ。points はそのスプリントの完了の記録（completions.sprint_id がこのスプリント）の
// points の合計（完了の記録の修正で直した値のまま。ポイントが空の記録は 0）。
// counted が偽のスプリントは、延長した（extended_days が 1 以上）ので平均に入れず、除いたことを画面が示す
export const velocitySprintSchema = sprintRefSchema.extend({
  extended_days: z.number().int(),
  points: z.number().int(),
  counted: z.boolean(),
});

export type VelocitySprint = z.output<typeof velocitySprintSchema>;

// ベロシティ。average は counted が真のスプリントの points の平均（対象が 0 なら null）、sprints は古い順
export const planVelocitySchema = z.object({
  average: z.number().nullable(),
  sprints: z.array(velocitySprintSchema),
});

export type PlanVelocity = z.output<typeof planVelocitySchema>;

// 先のスプリント（planned と active）1つの集計。points は入っている削除していないタスクのポイントの合計（未見積もりは 0。
// 進行中のスプリントで完了したタスクも含む。計画の画面の「N 件・M pt」と同じ数え方）、task_count はその件数、
// unestimated_count は入っている完了していないタスクのうち未見積もり（points が空）の件数
export const planLaneSchema = z.object({
  sprint_id: z.string(),
  points: z.number().int(),
  task_count: z.number().int(),
  unestimated_count: z.number().int(),
});

export type PlanLane = z.output<typeof planLaneSchema>;

// 削除していない、完了も中止もしていないエピック1つの、配下のポイント。バックログの木（backlog-tree）のエピックの
// points_done と points_all と同じ数え方（配下のストーリーのタスクのポイントの合計。未見積もりは 0）。
// 残りのポイントは points_all - points_done（配下の未完了のタスクのポイントの合計）
export const planEpicSchema = z.object({
  id: z.string(),
  title: z.string(),
  due_on: z.string().nullable(),
  points_done: z.number().int(),
  points_all: z.number().int(),
});

export type PlanEpic = z.output<typeof planEpicSchema>;

// 計画の画面の集計。sprint-list（タスクの行まで返す）は広げず、画面の見出しの集計、ベロシティ、先のスプリントごとの入れたポイント、
// エピックごとの残りだけを返す。
// - velocity.sprints: 終了した（status = 'closed'）削除していないスプリントのうち、延長していない（extended_days = 0）新しい 3 つ
//   （開始日の新しい順に選ぶ。3 つに満たなければあるだけ）と、その 3 つのうち最も古いものより後に始まった、延長したスプリント
//   （counted が偽。最大 6 つ）。古い順に並べる（棒グラフの左から右）。
//   3 つに満たないときの延長したスプリントは、終了した全部のうち新しい 6 つまで
// - velocity.average: counted が真のスプリントの points の平均。対象が 0 なら null（画面は「まだ出ません」）
// - lanes: 削除していない planned と active のスプリントごと（開始日、id の順。sprint-list と同じ）
// - epics: 削除していない、完了も中止もしていないエピック（position、id の順）
// today はワークスペースのタイムゾーンでの今日、week_start は週の始まり（0 が日曜）。エピックの期日の印を決める。
// 閉じたワークスペースでも読める
export const planSummary = defineOperation({
  name: 'plan-summary',
  description:
    '計画の画面の集計を返す。延長したスプリントを除いた直近 3 スプリントの完了ポイントの平均（ベロシティ）、先のスプリントごとの入れたポイントと件数と未見積もりの件数、エピックごとのポイント',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
    velocity: planVelocitySchema,
    lanes: z.array(planLaneSchema),
    epics: z.array(planEpicSchema),
  }),
});
