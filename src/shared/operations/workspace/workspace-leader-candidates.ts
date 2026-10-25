import { z } from 'zod';
import { defineOperation } from '../define.ts';

// ワークスペースを作るダイアログが、開いたときに取る。無効でなく login_subject のあるユーザーだけで、
// Google で待っている行（login_subject が空）は出さない。ワークスペースへの所属の有無は問わない
export const workspaceLeaderCandidates = defineOperation({
  name: 'workspace-leader-candidates',
  description: '最初のリーダーに指せる、この組織のユーザーの ID と名前を返す',
  mode: 'read',
  permission: 'admin',
  input: z.object({}),
  output: z.object({ users: z.array(z.object({ id: z.string(), name: z.string() })) }),
});
