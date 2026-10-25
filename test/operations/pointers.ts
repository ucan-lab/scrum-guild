// 組織の中の操作ごとのテスト用の関数（docs/development.md の「操作の定義」）。操作を src/server/operations/index.ts の一覧に足したら、
// 同じ PR でここに足す。足し忘れると test/operation-registry.test.ts が落ちる。
// キーは操作の名前。値は、対象の組織の行を指す成功する入力を作る関数（別の組織の対象を渡すと 404 になる入力）
import type { Pointers } from './harness.ts';

export const pointers: Pointers = {
  // 入力は空。組織は URL の slug で決まる
  organization: { noReference: {} },
  // 最初のリーダーに、対象の組織の管理者を指す。別の組織の管理者を指すと 404
  'workspace-create': async (target) => ({
    name: '保守チーム',
    timezone: 'Asia/Tokyo',
    vocabulary: 'game',
    leader_user_id: target.admin.userId,
  }),
  'workspace-list': { noReference: {} },
  'workspace-leader-candidates': { noReference: {} },
  workspace: async (target) => ({ workspace_id: target.workspace.id }),
};
