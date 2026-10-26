import { z } from 'zod';
import { epicTitleSchema } from '../../epic.ts';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema } from '../../story.ts';
import { defineOperation } from '../define.ts';
import { epicDetailSchema } from './epic.ts';

// エピックを作る。position はエピックの末尾。作った人（created_by）と依頼主（requester_user_id）は呼んだ人で、
// クリア報酬の段階（reward_tier）は medium。タイトル以外の欄は省略でき、空は null になる。
// 区分（category_id）は、同じワークスペースの削除していない区分でなければ 404（別の組織も 404）。
// 変更の履歴（entity_type = 'epic'、create）も同時に書く
export const epicCreate = defineOperation({
  name: 'epic-create',
  description: 'エピックを作る。タイトル、本文、期日、リンク、区分を指す（タイトル以外は任意）。位置はエピックの末尾',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    title: epicTitleSchema,
    body_md: longTextSchema.default(null),
    due_on: dueOnSchema.default(null),
    link_url: linkUrlSchema.default(null),
    category_id: idSchema.nullable().default(null),
  }),
  output: z.object({ epic: epicDetailSchema }),
});
