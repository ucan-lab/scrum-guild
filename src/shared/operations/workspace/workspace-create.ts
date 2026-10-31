import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { timezoneSchema } from '../../timezone.ts';
import { workspaceNameSchema } from '../../workspace.ts';
import { defineOperation } from '../define.ts';

// 作ると同時に、既定の列、決まった欄、換算比率、最初のリーダーの所属を書く（1回の batch）。
// 最初のリーダーは、いまこの組織に入れる、無効でなく login_subject のあるユーザー（workspace-leader-candidates が返す人）。
// 管理者自身を指したときだけ所属ができる。指さないときは、作った管理者の memberships の行を作らない。
// timezone は検証のときに正規の名前（asia/tokyo は Asia/Tokyo）にそろう
export const workspaceCreate = defineOperation({
  name: 'workspace-create',
  description:
    'ワークスペースを作る。名前、タイムゾーン、最初のリーダーを指す。既定の列、決まった欄、換算比率（1ポイント = 4時間）、週の始まり（月曜）も同時に入れる',
  mode: 'write',
  permission: 'admin',
  input: z.object({
    name: workspaceNameSchema,
    timezone: timezoneSchema,
    leader_user_id: idSchema,
  }),
  output: z.object({ workspace_id: z.string() }),
});
