// 束縛の上限（send.ts の MAX_BOUND_PARAMETERS）で区切るための分け方。組織の ID の束を organization_id IN (...) で渡す文が使う
export function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
