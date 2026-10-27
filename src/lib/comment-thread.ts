// 引き出しの「コメント」のタブの一覧を、読み直しの応答から作り直す（TaskComments.svelte が使う）。画面の状態に頼らない
import type { Comment, CommentCursor } from '../shared/operations/task/index.ts';

export type ThreadView = { comments: readonly Comment[]; next: CommentCursor | null; count: number };

// 書いた順（created_at、同じなら id）での前後。負なら a が先
export function compareComments(a: Pick<Comment, 'created_at' | 'id'>, b: Pick<Comment, 'created_at' | 'id'>): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

// 読み直し（新しい 50 件）の応答から一覧を作る。
// - 前に「前のコメントを読む」で足した古い行は、応答の先頭の行が前の一覧にあるとき（地続き）だけ残し、続きは前の next のまま。
//   地続きでなければ（読み直すまでに 50 件を超えて足された）、抜けた区間を作らないよう古い行を捨て、応答の next にする
// - writes は、この読み直しを始めた後に書いた（作った、直した、消した）行。古い応答で消えないよう、応答の行に重ねる。
//   応答に無い作った行は、読んでいる区間にあれば並びの位置に差し込む。件数は、応答に無かった作成と、応答で生きていて消した行の分だけ動かす
export function reloadView(
  previous: ThreadView,
  fresh: { comments: readonly Comment[]; next: CommentCursor | null; count: number },
  writes: readonly Comment[],
): ThreadView {
  const first = fresh.comments[0];
  const contiguous = first !== undefined && previous.comments.some((comment) => comment.id === first.id);
  const kept = contiguous ? previous.comments.filter((comment) => compareComments(comment, first) < 0) : [];
  const rows = [...kept, ...fresh.comments];
  const next = kept.length > 0 ? previous.next : fresh.next;
  let count = fresh.count;
  for (const written of writes) {
    const at = rows.findIndex((comment) => comment.id === written.id);
    if (at >= 0) {
      if (rows[at]!.deleted_at === null && written.deleted_at !== null) count -= 1;
      rows[at] = written;
      continue;
    }
    // 読んでいない区間（next より前）の行は置かない
    const oldest = rows[0];
    if (next !== null && (oldest === undefined || compareComments(written, oldest) < 0)) continue;
    const insertAt = rows.findIndex((comment) => compareComments(written, comment) < 0);
    rows.splice(insertAt < 0 ? rows.length : insertAt, 0, written);
    if (written.deleted_at === null) count += 1;
  }
  return { comments: rows, next, count: Math.max(0, count) };
}
