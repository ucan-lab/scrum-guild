// 手で並べ替える並び（position）で、移す行の新しい位置を決める。タスクの移動とストーリーの移動が使う。
// 並びは position、id の順（同じ値の行は id の順）。読み取りは各操作が、移す先の中から移す行を除いて行う
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export type Positioned = { id: string; position: string };

// 新しい位置と、同じ値の行の振り直し。振り直す行は、読んだときの値（from）のままなら to に書く
export type MovePlan = { position: string; renumber: { id: string; from: string; to: string }[] };

// 先頭。first は移す先の最初の行
export function placeFirst(first: Positioned | undefined): MovePlan {
  return { position: generateKeyBetween(null, first?.position ?? null), renumber: [] };
}

// 末尾。last は移す先の最後の行
export function placeLast(last: Positioned | undefined): MovePlan {
  return { position: generateKeyBetween(last?.position ?? null, null), renumber: [] };
}

// 直前の行（after）の直後。ties は after と同じ値で id が after より後ろの行（id の順）、next は after より大きい値の最初の行。
// ties があると、after と ties の間に入れる値が無い（同時に作った行は同じ値になりうる）。そのときは、移す行と ties を
// after と next の間に並べて振り直す（先頭の値が移す行、残りが ties の順）
export function placeAfter(after: Positioned, ties: readonly Positioned[], next: Positioned | undefined): MovePlan {
  const upper = next?.position ?? null;
  if (ties.length === 0) return { position: generateKeyBetween(after.position, upper), renumber: [] };
  const keys = generateNKeysBetween(after.position, upper, ties.length + 1);
  return {
    position: keys[0]!,
    renumber: ties.map((row, index) => ({ id: row.id, from: row.position, to: keys[index + 1]! })),
  };
}
