import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { longTextSchema } from '../../story.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 決まった欄を書くのを 409 の conflict で断った理由（details.reason）。
// changed は、読んだ値から書くまでの間に、別の要求が同じ欄を直した（行を足した、直した、消した）。画面は読み直しを促す
export const taskFieldConflictReasons = ['changed'] as const;
export type TaskFieldConflictReason = (typeof taskFieldConflictReasons)[number];

export function taskFieldConflictReasonOf(details: unknown): TaskFieldConflictReason | undefined {
  return conflictReasonOf(details, taskFieldConflictReasons);
}

// 引き出しが出す、決まった欄1つ。value_md は書かれていなければ null（未記入）
export const taskFieldValueSchema = z.object({
  id: z.string(),
  name: z.string(),
  value_md: z.string().nullable(),
});
export type TaskFieldValue = z.output<typeof taskFieldValueSchema>;

// タスクの決まった欄（task_field_values）に値を書く。value_md は本文と同じ正規化（改行をそろえ、前後の空行と末尾の空白を落とす。
// 1 万字まで）を通し、空（空白だけを含む）か null なら行を消す。
// read_md は、書く人が読んだときの値（行が無ければ null）。読んだ値のままなら書き、違えば 409 の conflict（reason は changed）で断る。
// 書く文の条件にする（行が無いこと、value_md が読んだ値のまま）ので、同時に書いても、後の人が先の人の値を黙って上書きしない。
// 読んだ値と書く値が同じなら何も書かず（履歴も残さず）、今の行を返す。
// 変更の履歴は entity_type = 'task'、action = 'update'、{"field": [前, 後]}。前後は欄の {id, name}（その欄に値があった／あるとき）か null
// （無かった／無くなる）だけで、値の全文は入れない。
// 無いタスク・削除した欄（別の組織・別のワークスペース・削除済みを含む）は 404。閉じたワークスペースは 409 の workspace_closed。
// 返すのは、書いた後の欄と、そのタスクが未記入か（完了していないバックログのタスクで、削除していない欄に値の行が無いものがあるとき真）。
// 書く文が0行だったとき、読み直した今の値がすでに書こうとした値（空にするなら行なし）なら、成功した書き込みの再送として 409 にせず 200 で今の値を返す（履歴は残さない）
export const taskFieldSet = defineOperation({
  name: 'task-field-set',
  description:
    'タスクの決まった欄に値を書く。空にすると未記入に戻る。読んだ値のままなら書き、違えば 409（changed）で断る。履歴には欄の名前だけを残す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    task_id: idSchema,
    field_id: idSchema,
    value_md: longTextSchema,
    read_md: longTextSchema,
  }),
  output: z.object({ field: taskFieldValueSchema, unfilled: z.boolean() }),
});
