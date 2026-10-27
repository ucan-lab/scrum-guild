import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 1回に送れるタスクの数。ストーリーをまとめて入れるときも、配下の未完了のタスクがこの数に収まる想定
export const SPRINT_TASK_ADD_MAX = 200;

// 先のスプリント（planned）か進行中のスプリント（active）に、バックログのタスクを入れる。ストーリーをまとめて入れる画面は、
// 配下の未完了のタスクの ID を送る（入れる単位はタスク）。入れたタスクは先頭の列の末尾に置き、sprint_entries に入った行を足し、
// 変更の履歴（{"sprint": [前, 後]}）を残す。別のスプリントに入っているタスクは、前の行を removed で閉じて移す。
// 入れられるものだけを入れ、入れた件数と、飛ばした件数を理由ごとに返す（completed は完了したもの、unavailable は削除した、無い、
// 別のワークスペースや別の組織、バックログにないもの。あるかどうかを漏らさないよう、無いものと区別しない。
// already は同じスプリントに既に入っていたもので、何も書かない）。
// 1件も入らず、既に入っていたものも無ければ、1件のときと同じエラーにする（終了したスプリントは 409 の conflict（closed）、
// スプリントが無いか別の組織なら 404、完了したタスクだけなら 409 の conflict（completed）、入れられないタスクがあれば 404）
export const sprintTaskAdd = defineOperation({
  name: 'sprint-task-add',
  description:
    'スプリントにバックログのタスクを入れる。入れられないもの（完了、削除、別のワークスペース、既に入っている）は飛ばし、件数を理由ごとに返す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    sprint_id: idSchema,
    task_ids: z.array(idSchema).min(1).max(SPRINT_TASK_ADD_MAX),
  }),
  output: z.object({
    added: z.number().int(),
    skipped: z.object({
      completed: z.number().int(),
      unavailable: z.number().int(),
      already: z.number().int(),
    }),
  }),
});
