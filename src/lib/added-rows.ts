// 画面で足したタスクの行を、読み直しのあとも残すか。木の画面（`src/routes/[slug]/w/[id]/+page.svelte`）が使う。
// at は足した時刻、loadedAt は読み直しを始めた時刻（どちらも performance.now()）。
// - 完了にした行と、読み直した木に入った行は捨てる（木が持つので、足した行は要らない）
// - 木に無い行は、足した後に始まった読み直しの木なら捨てる（別の人の削除か、親ごとの消失。サーバーの今を返している）
// - 足す前に始まった読み直しが遅れて届いた木なら残す（作った行が木に無いのは当たり前）。同じ時刻も残す側に倒す（時刻の粒度が粗い環境の対策）
// - 木を読めていない（treeLoaded が偽）ときは、木に無いと言えないので残す
export function keepAddedRow(
  row: { at: number },
  state: { inLoadedTree: boolean; completed: boolean; treeLoaded: boolean; loadedAt: number },
): boolean {
  if (state.completed || state.inLoadedTree) return false;
  return !state.treeLoaded || row.at >= state.loadedAt;
}
