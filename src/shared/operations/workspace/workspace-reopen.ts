import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 閉じたワークスペースを開き直す。workspaces の closed_at を空にし、change_logs（action: reopen）を1回の batch で書く。
// 閉じたワークスペースでも通す書き込みなので allowClosed を付ける。開いているものを開き直すと 409 の conflict
export const workspaceReopen = defineOperation({
  name: 'workspace-reopen',
  description:
    '閉じたワークスペースを開き直す。閉じた日時を空にし、変更の履歴にも残す。開いているワークスペースには 409 の conflict',
  mode: 'write',
  permission: 'admin',
  workspace: true,
  allowClosed: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ workspace_id: z.string() }),
});
