import type { Vocabulary } from '../shared/vocabulary.ts';

// ワークスペースの枠（src/routes/[slug]/w/[id]/+layout.ts）が読み込む、今開いているワークスペース。
// 組織の枠のメニューと上の帯も、page.data から同じ値を読む。role は自分の今のロールで、所属していない管理者では null
export type WorkspaceView = {
  id: string;
  name: string;
  vocabulary: Vocabulary;
  closedAt: string | null;
  role: 'leader' | 'member' | null;
};

// page.data（全部の枠のデータを混ぜた値）から、今開いているワークスペースを取り出す。ワークスペースの画面の外では null
export function workspaceViewOf(data: Record<string, unknown>): WorkspaceView | null {
  const value = data.workspace;
  if (typeof value !== 'object' || value === null) return null;
  const view = value as Partial<WorkspaceView>;
  return typeof view.id === 'string' && typeof view.name === 'string' ? (view as WorkspaceView) : null;
}
