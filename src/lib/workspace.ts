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

// 直前に読めたワークスペース。key は「組織の slug/ワークスペースの ID」
export type KnownWorkspace = { key: string; workspace: WorkspaceView };

// 一時的な失敗（通信、5xx）。読み直せば直るかもしれないので、前に読めた値を保ってよい
export function isTransientFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

// 読み直しの結果から、枠が使うワークスペースと、次に保つ値を決める。
// 一時的な失敗のときだけ、同じワークスペースの直前の値を保つ（保存の後の読み直しが一時的に失敗しても、枠が「読み込めない」に
// 切り替わって引き出しごと消え、書きかけが黙って失われないように）。見つからない（404）、入れない（403）、未ログイン（401）など、
// 読み直しても直らない失敗では保たず、覚えていた値も消す
export function settleWorkspace(
  known: KnownWorkspace | null,
  key: string,
  loaded: WorkspaceView | null,
  failureStatus: number,
): { workspace: WorkspaceView | null; known: KnownWorkspace | null } {
  if (loaded !== null) return { workspace: loaded, known: { key, workspace: loaded } };
  if (!isTransientFailure(failureStatus)) return { workspace: null, known: null };
  return { workspace: known?.key === key ? known.workspace : null, known };
}

// page.data（全部の枠のデータを混ぜた値）から、今開いているワークスペースを取り出す。ワークスペースの画面の外では null
export function workspaceViewOf(data: Record<string, unknown>): WorkspaceView | null {
  const value = data.workspace;
  if (typeof value !== 'object' || value === null) return null;
  const view = value as Partial<WorkspaceView>;
  return typeof view.id === 'string' && typeof view.name === 'string' ? (view as WorkspaceView) : null;
}
