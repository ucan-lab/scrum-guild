// 並んだ行の中へ、行を1つ落とすときの行き先。ドラッグの結果から、並べ替えの操作の入力（直前の行）と、読み上げる新しい位置を作る。
// ids は行き先の親の中の並び（動かす行が今そこにあれば、その行も含む）。今と同じ位置に落とすときは null を返し、画面は何も送らない。
export type Insertion = {
  // 直前に置く行。null は先頭。undefined は「省く」で、移した先の末尾に置く
  afterId: string | null | undefined;
  // 動かした後の並びでの位置（0 始まり）
  index: number;
  // 移した先の末尾に置く落とし方か
  atEnd: boolean;
};

// anchorId の行の前（before）か後ろ（after）に落とす
export function insertAround(
  ids: readonly string[],
  sourceId: string,
  anchorId: string,
  edge: 'before' | 'after',
): Insertion | null {
  if (anchorId === sourceId) return null;
  const rest = ids.filter((id) => id !== sourceId);
  const anchor = rest.indexOf(anchorId);
  if (anchor === -1) return null;
  const index = edge === 'before' ? anchor : anchor + 1;
  if (ids.indexOf(sourceId) === index) return null;
  return { afterId: index === 0 ? null : rest[index - 1]!, index, atEnd: false };
}

// 並びの末尾に落とす。直前の行は渡さない（サーバーが移した先の末尾に置く）
export function insertAtEnd(ids: readonly string[], sourceId: string): Insertion | null {
  const rest = ids.filter((id) => id !== sourceId);
  if (ids.indexOf(sourceId) === rest.length) return null;
  return { afterId: undefined, index: rest.length, atEnd: true };
}
