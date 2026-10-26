import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// ストーリーの完了を取り消す。完了した日時と完了にした人を空に戻し、打ち消されていない完了の経験値（story_completed）を
// 打ち消しの明細で取り消す。もう一度完了にすると付け直す。完了していなければ 409 の conflict（not_completed）、
// 親のエピックが完了か中止していれば 409 の conflict（parent_completed）。理由は story-complete.ts の一覧。
// 変更の履歴（entity_type = 'story'、reopen）も同じ batch() で書く。無いストーリー（別の組織を含む）は 404
export const storyReopen = defineOperation({
  name: 'story-reopen',
  description: 'ストーリーの完了を取り消し、完了で付けた経験値を打ち消す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, story_id: idSchema }),
  output: z.object({ story_id: z.string() }),
});
