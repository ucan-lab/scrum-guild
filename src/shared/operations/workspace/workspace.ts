import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { workspaceVocabularySchema } from '../../workspace.ts';
import { defineOperation } from '../define.ts';

// ワークスペースの枠が使う。画面の言葉づかいはここで返す vocabulary で当てる。
// role は自分の今のロール。所属していない管理者では null
export const workspaceInfo = defineOperation({
  name: 'workspace',
  description: 'ワークスペースの名前、言葉づかい、閉じた日時と、自分のロール（所属していなければ空）を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    name: z.string(),
    vocabulary: workspaceVocabularySchema,
    closed_at: z.string().nullable(),
    role: z.enum(['leader', 'member']).nullable(),
  }),
});
