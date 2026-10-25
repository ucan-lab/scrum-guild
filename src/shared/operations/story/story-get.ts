import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { storyDetailSchema } from './story.ts';

// ストーリーのダイアログを開くときに、ストーリー1件の全部の欄を読む。受け入れ基準と本文は長い（それぞれ 1 万字まで）ので、
// バックログの木（backlog-tree）には載せない。閉じたワークスペースでも読める。
// 無いストーリー（別の組織・別のワークスペース・削除済みを含む）は 404
export const storyGet = defineOperation({
  name: 'story-get',
  description: 'ストーリー1件のタイトル、受け入れ基準、本文、期日、リンクを返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, story_id: idSchema }),
  output: z.object({ story: storyDetailSchema }),
});
