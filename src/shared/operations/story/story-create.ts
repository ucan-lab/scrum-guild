import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema, storyTitleSchema } from '../../story.ts';
import { defineOperation } from '../define.ts';
import { storyDetailSchema } from './story.ts';

// ストーリーを作る。親はなし（epic_id は空）で、position は親のないストーリーの末尾。作った人（created_by）は呼んだ人。
// タイトル以外の欄は省略でき、空は null になる。変更の履歴（entity_type = 'story'、create）も同時に書く
export const storyCreate = defineOperation({
  name: 'story-create',
  description:
    '親のないストーリーを作る。タイトル、受け入れ基準、本文、期日、リンクを指す（タイトル以外は任意）。位置は親のないストーリーの末尾',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    title: storyTitleSchema,
    acceptance_criteria_md: longTextSchema.default(null),
    body_md: longTextSchema.default(null),
    due_on: dueOnSchema.default(null),
    link_url: linkUrlSchema.default(null),
  }),
  output: z.object({ story: storyDetailSchema }),
});
