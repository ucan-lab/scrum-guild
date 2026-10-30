import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 列を削除する（論理削除）。進行中と先のスプリントの、この列にいる未完了のタスクは、同じ batch() で target_column_id の列の、
// そのスプリントでの末尾へ、元の列の中の順を保って移し、タスクごとの変更履歴に task-column-move と同じ
// {"column": [{id, name}, {id, name}]} を残す。終了したスプリントのカードは変えない（削除した列を指したまま）。
// 変更の履歴（entity_type = 'workspace'、update、{"column": [{id, name}, null]}。移したときは "target_column": [null, {id, name}] も）も書く。
// 409 の conflict の理由は columnConflictReasons:
// done_column（完了の列）、last_column（完了以外で最後の1つ。同時に2つ消して0になるのも書く文の条件で止める）、
// target_required（移すタスクがあるのに target_column_id が無い）、target_invalid（移し先が削除する列自身か完了の列）、
// changed（読んでから書くまでに列かタスクが変わり、読み直してもやり直せなかった）。
// 削除する列と移し先が無い（別の組織、別のワークスペース、削除済みを含む）ときは 404。出力の moved_count は移したタスクの数
export const columnDelete = defineOperation({
  name: 'column-delete',
  description: '列を削除し、残っている未完了のタスクを移し先の列の末尾へ移す。完了の列と最後の1つは削除できない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, column_id: idSchema, target_column_id: idSchema.optional() }),
  output: z.object({ column_id: z.string(), moved_count: z.number().int() }),
});
