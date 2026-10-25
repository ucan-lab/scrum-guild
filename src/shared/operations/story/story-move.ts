import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// ストーリーを並べ替える、親を移す。epic_id は移す先の親のエピック（null は親なし）。
// after_story_id は移す先の中で直前に置く行で、null は先頭、省くと末尾。直前の行は、移す先の削除していないストーリー
// （完了したストーリーも指せる）でなければ 404、移すストーリー自身なら 400 の invalid_input。
// 移すストーリーと親が無い（別の組織を含む）ときは 404、完了したか中止したエピックの下へは 409 の conflict。
// 親が変わったときだけ change_logs に {"epic": [前, 後]} を残し、エピックの下へ移したら区分を空にする
export const storyMove = defineOperation({
  name: 'story-move',
  description:
    'ストーリーを並べ替えるか、親のエピックを移す。移す先の中で、指した行の直後（null は先頭、省くと末尾）に置く',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    story_id: idSchema,
    epic_id: idSchema.nullable(),
    after_story_id: idSchema.nullable().optional(),
  }),
  output: z.object({ story_id: z.string(), epic_id: z.string().nullable() }),
});
