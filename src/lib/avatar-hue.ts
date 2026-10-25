// アバターの色相（0 以上 360 未満）を users.id から計算する。DB に列は持たない。
// UUIDv7 は先頭が時刻なので、先頭だけでなく全体を混ぜる（FNV-1a）。同じ id は常に同じ色になる
export function hueOf(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}
