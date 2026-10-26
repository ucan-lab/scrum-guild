import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { epicDetailSchema } from './epic.ts';

// エピックのダイアログを開くときに、エピック1件の全部の欄を読む。本文は長い（1 万字まで）ので、バックログの木には載せない。
// 閉じたワークスペースでも読める。無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404
export const epicGet = defineOperation({
  name: 'epic-get',
  description: 'エピック1件のタイトル、本文、期日、リンクを返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({ epic: epicDetailSchema }),
});
