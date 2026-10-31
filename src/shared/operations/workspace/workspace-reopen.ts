import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 閉じたワークスペースを開き直す。workspaces の closed_at を空にし、change_logs（action: reopen）を1回の batch で書く。
// 閉じたワークスペースでも通す書き込みなので allowClosed を付ける。開いているものを開き直すと 409 の conflict。
// 閉じている間、そのワークスペースの承諾待ちの招待の人は組織の人数に数えない。開き直すと新しく数えられるので、
// 新しく数えられる人（adding）が1人以上で、今の人数（used）に足すと上限（limit）を超えるときは、書かずに
// 409 の member_limit_reached で断る。details は { used, limit, adding }。adding が 0 の開き直しは、上限を超えている組織でも通す
export const workspaceReopen = defineOperation({
  name: 'workspace-reopen',
  description:
    '閉じたワークスペースを開き直す。閉じた日時を空にし、変更の履歴にも残す。開いているワークスペースには 409 の conflict。開き直すと新しく人数に数えられる人がいて、足すと組織の人数の上限を超えるときは、何も書かずに 409 の member_limit_reached（details は { used, limit, adding }）',
  mode: 'write',
  permission: 'admin',
  workspace: true,
  allowClosed: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ workspace_id: z.string() }),
});
