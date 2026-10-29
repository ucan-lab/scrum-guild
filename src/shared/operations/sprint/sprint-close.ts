import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';
import { sprintRefSchema } from './sprint.ts';

// スプリントの終了（sprint-close）を 409 の conflict で断った理由（details.reason）。
// not_active は終えるスプリントが進行中でない（始まっていない、終了した。2つの画面から同時に終えた後の要求を含む）、
// carry_target は持ち越し先が先のスプリント（planned）でないか、終えるスプリントの最終日より前に始まるか、最終日がワークスペースの今日より前（始められない）、
// changed は読んでから書くまでに中の未完了のタスクが変わる（入った、外れた、完了した）などして、読み直して3回やり直しても書けなかった
export const sprintCloseConflictReasons = ['not_active', 'carry_target', 'changed'] as const;
export type SprintCloseConflictReason = (typeof sprintCloseConflictReasons)[number];

export function sprintCloseConflictReasonOf(details: unknown): SprintCloseConflictReason | undefined {
  return conflictReasonOf(details, sprintCloseConflictReasons);
}

// 進行中のスプリントを終える。carry_sprint_id は終わらなかった（未完了の）タスクの持ち越し先で、先のスプリント（planned。終えるスプリントの
// 最終日より後に始まり、最終日がワークスペースの今日以降のもの）の ID か、null（バックログ）。is_goal_achieved はゴールを書いて始めたスプリントでは真偽が要り、
// ゴールのないスプリントでは null（合わなければ 400 の invalid_input）。
// スプリントを closed にし（closed_at、closed_by、is_goal_achieved）、入っている行を閉じる（完了したタスクは completed、未完了のタスクは
// carried_over。どちらの ended_at も終了の日時）。持ち越すタスクは、終えるスプリントでの並び（列の順、列の中の位置、id）のまま
// 持ち越し先の先頭の列の末尾へ並べ（バックログなら sprint_id、column_id、column_position を空にし）、スプリントなら新しい行を足す。
// 完了したタスクは sprint_id と列を変えず、終えたスプリントの完了の列に残る。変更の履歴は、スプリントに
// {"status": ["active", "closed"], "is_goal_achieved": [null, 真偽]}（ゴールがなければ status だけ）、持ち越したタスクごとに
// {"sprint": [前, 後]}（バックログへなら後は null）を残す。
// 断るもの: スプリントか持ち越し先が無い（別の組織、別のワークスペース、削除したものを含む）は 404、進行中でないスプリントは
// 409 の conflict（not_active）、持ち越し先が合わなければ 409 の conflict（carry_target）、閉じたワークスペースは 409 の workspace_closed、
// 読んでから書くまでに中のタスクが変わって3回やり直しても書けなければ 409 の conflict（changed）。
// 返すのは終えたスプリントの ID、持ち越した件数、持ち越し先（バックログは null）
export const sprintClose = defineOperation({
  name: 'sprint-close',
  description:
    '進行中のスプリントを終える。終わらなかったタスクを先のスプリントかバックログへ持ち越し、ゴールがあれば達成したかを記録する',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    sprint_id: idSchema,
    carry_sprint_id: idSchema.nullable(),
    is_goal_achieved: z.boolean().nullable().default(null),
  }),
  output: z.object({
    sprint_id: z.string(),
    carried_count: z.number().int(),
    carry_to: sprintRefSchema.nullable(),
  }),
});
